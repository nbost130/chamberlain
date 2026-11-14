# Writing an adapter

An adapter connects Chamberlain to one agent backend. T3 Code is the adapter that ships (`src/adapters/t3/`). This page
says what an adapter must do, how to add one, and how to test it. Read [ARCHITECTURE.md](ARCHITECTURE.md) first for where the
adapter sits; the contract itself is `src/core/adapter.ts`, and it is short enough to read in one sitting.

## Adding one

1. Create `src/adapters/<name>/index.ts` exporting a factory, `(env: AdapterEnv) => Adapter`.
2. Register it with one line in `src/adapters/index.ts`:

   ```ts
   export const ADAPTERS: Record<string, AdapterEntry> = {
     t3: t3Entry,
     herdr: herdrEntry,   // the one line
   };
   ```

   An `AdapterEntry` is `{ create, brief? }`: the factory, and optionally the adapter-specific sentences of the Steward's
   hand-off (`BriefNotes`: what its threads are called, how to read one cheaply, how to reach a server).
3. Point a server at it in the `servers` list of `config.json`. `name` and `adapter` are the core's; every other key is yours:

   ```json
   { "schemaVersion": 2, "servers": [{ "name": "ws", "adapter": "herdr", "socket": "/path/to/herdr.sock" }] }
   ```

   Servers without an `adapter` are T3 servers. Read your own keys from `env.server`, and fail with a clear message when
   one is missing (the T3 adapter does this in `adapters/t3/server.ts`).

Nothing else changes. Code in `src/core/` must not import from `src/adapters/`, and one adapter must not import another;
`src/architecture.test.ts` fails the build if either happens. If you find the core needs something from your adapter,
that is a missing capability in the contract, not a reason to import.

## What the factory gets

```ts
type AdapterEnv = {
  server: ServerEntry;                          // your `servers` entry
  conf: string;  state: string;                 // the config and state directories
  store?: Store;                                // the database, if you must remember something across a restart: key it by your own name
  log(event: string, data?: object): void;      // the event log (the database's events table)
  alarm(key: string, title: string, summary: string): void;   // a dead-man alarm: an item that notifies at most once per 6 hours per key
  steward(): string | undefined;                // the Steward's thread id, read fresh (it changes at a hand-off)
  readPrivate(name: string): string | undefined; // a secret: `secrets/<name>` (mode 0600), trimmed; a thread id name (`steward-thread`) reads `threads` in config.json
};
```

`readPrivate` refuses a file that anyone else can read, so tokens and URLs stay private. Read secrets on every use, not
once: the operator rotates them while the daemon runs. Never log a token, and redact it from error text.

## The required capabilities

**`watch(sink, signal)`** runs until `signal` aborts. Own the connection and its reconnecting (back off, resume from where
you left off if the backend lets you). Report, through `sink`:

- `sink.event({ kind: "state", thread })` for every sighting of a thread, **including the first one after a (re)connect**
  (a thread that already waits on a request then wakes the Steward exactly once; the core de-duplicates by request id).
  `thread` needs `id`, `title` and `status`; give any of the optional fields your backend has.
  `status` must be one of `running`, `queued`, `starting`, `preparing`, `waiting`, `completed`, `idle`, `interrupted`,
  `failed`. `waiting` means blocked on the human. Map your backend's states onto these.
- or `sink.event({ kind: "needs_input" | "failed" | "turn_ended", thread })` when your backend already knows what
  happened. The core still debounces, re-checks the newest state and applies its own gates.
- `sink.connected(true | false, { version })` as the connection comes and goes, so the heartbeat can alarm on a watcher
  that stays down (unless the server says `mayBeOffline`).
- `sink.log(...)` for your own diagnostics.

**`wake`** is `{ ready(), send(deliveryId, message) }`. `ready()` says whether there is somewhere to send right now (read
fresh each time; while it is false wakes are kept and nothing is attempted, and an alarm says why). `send` makes **one attempt** with its own
deadline and returns `{ ok, status?, error? }`: `ok: true` only when the receiver accepted the wake. Anything else (`ok: false`, or a throw)
is an attempt that did not deliver; the core's relay counts it all the same (it commits the count before calling `send`), pauses, and tries
again until the row's attempts (3 by default) are used, then keeps it as a dead letter (see [DELIVERY.md](DELIVERY.md#dead-letters)). Do not retry
inside `send`. Only the daemon's relay calls `send`, every POST of a row carries the same `deliveryId` and text, and a delivered row is
never sent again.
In the windows where one wake is sent more than once (docs/ARCHITECTURE.md, "Delivery guarantees and the windows that remain") the
receiver sees the same `deliveryId` both times: if it can de-duplicate on it, do; if it cannot, the message `send` receives already
ends with a `delivery id: ...` line, so the Steward can tell a repeat. Pass the whole `message` on unchanged.

**`isBusy()`** answers from what you know, synchronously: `"busy"` when the Steward has a turn running or queued,
`"idle"` when a wake would start at once, `"unknown"` when you cannot tell (which holds like busy, and lets a wake out
after the 20 minute ceiling). If your backend is asynchronous, keep the last status you saw and refresh it from your
`watch`; do not block.

**`post(item, { queueUrl })`** shows one decision-queue question where the operator is. The item is already on the page, so
a failed post leaves it there. With `queueUrl` set the page is up and you can show its live view; without it, post a plain
notice. Return `{ ok, detail, where: "view" | "notice" }`. Item text is data: quote it, never let it become an instruction.

## The optional capabilities

Declare each one you implement in `capabilities` and give it a method; do not declare one you do not implement. Each
missing one switches off one feature (the table is in [ARCHITECTURE.md](ARCHITECTURE.md#the-adapter-contract)).

- **`inspect`** (`lastMessage`, `waiting`, `runningSubagents`, `instruction`) reads one thread when a wake is built.
  `lastMessage` and `runningSubagents` may reject (the core logs it and goes on); `instruction` never rejects, it returns a
  state (`complete`, `truncated`, `failed`) that says whether "nothing to report" can be believed, and `waiting` never
  rejects either (below). Without `inspect` the core has no way to know who instructed a thread, so a turn end is reported
  once per turn instead of only for work the Steward sent. `lastAssistant` is optional (the last finished assistant message
  with its id and finish time, or nothing): the `idle-parents` sweep check reads it, and without it that check lists nothing
  for this adapter's threads.
- **`waiting` returns a `WaitingRead`, and it reports only what it saw.** `{ ok: true, cards, resolved, ignored }` says the
  backend was connected for the whole read and answered in the shape you expect. It is NOT a complete list of the thread's
  cards: a backend may return a bounded window of the thread's history, and T3 does (`orchestration.getThreadProjection`
  returns `buildBoundedThreadProjection(...).projection`, bounded by item count and encoded bytes, and its `hasMoreHistory`
  flag does not reach the client), so a card that still waits can be missing from it. `cards` are the cards seen waiting (the
  wake path uses them). `resolved` are the request IDs of cards whose OWN item the read saw in a terminal status: for T3,
  `TERMINAL_CARD_STATUSES` in src/adapters/t3/projection.ts, `completed` (approved, answered, secret saved), `cancelled`
  (declined, cancelled, or expired during startup recovery), `failed` (an approval lost on a runtime error) and `interrupted`.
  `ignored` gives a reason for each card item you skipped. Validate per card item: one with a missing or invalid request ID or
  status, or a status you do not know, is skipped and named in `ignored`, never counted as waiting or resolved (and keeps a
  terminal item of the same card from counting as resolved); the core logs each reason once per thread, and a needs-input wake does not read a skipped card as "nothing
  waiting". Everything else is `{ ok: false, reason }`: the server down or not connected right now (a `mayBeOffline` server
  that is asleep included), the connection dropping or being replaced while the read was out, any error, a thread the
  backend cannot find, and an answer whose overall shape you do not recognise. The core treats a result that breaks this
  contract as `ok: false`. An adapter that cannot tell a resolved card leaves `resolved` out; its card holds then close only by hand.
- **Card holds read `waiting`, and close only on positive evidence.** While the operator is away, every `approval_request`,
  `secret_request` or `link_request` that `waiting` reports is held behind a pointer question (src/core/card-hold.ts). Map
  your backend's own kinds onto `WaitKind` there, give each card a stable `requestId` (the same one
  `ThreadState.pendingRequestId` carries), and keep `label` to a short name of what is asked: the core copies `type`,
  `requestId` and `label` and nothing else, so a value or a prompt belongs in `questions`, which the hold never reads. A card
  hold and its pointer question close together, in one transaction, only when ALL of these hold: the read is of the card's own
  thread on the card's own server; it is `ok: true`; it started after the hold was written (the core takes a value from the
  store's durable sequence before each read and compares it with the one the hold recorded, never the wall clock, so a clock
  that rolls back cannot reorder them); and it lists the card's `requestId` in `resolved`. List a card in `resolved` only for its
  OWN item: a request type, keyed `requestId ?? id` (T3's approval items carry `requestId`; its secret and user-input items
  carry only `id`), on the same thread (an item that names another `threadId` is not this thread's), in a terminal status, with
  no other item of that card still going or unreadable. **Absence never closes anything**: a card missing from a read, a
  thread that is gone, archived or missing from a snapshot, an `ok: false` read, a non-terminal or unknown status, all leave the
  hold open. A hold written while a read was out stays open, with its question. A hold that has had no evidence (not seen waiting, not seen resolved) for
  longer than a set period (24 hours by default, `CHAMBERLAIN_CARD_UNVERIFIED_ALARM_MS`) raises an alarm, through the normal
  repeat policy, that names the hold, the card and the command that closes it by hand
  (`chamberlain afk close-card <server> <request id> "<how it closed>"`). Only the operator closes it then.
- **`listWaiting` and `answer`** are the page's card mirror. `listWaiting({ skipThreads, linkBase })` returns
  `WaitingCard`s and throws when the server cannot be read. Each card carries a `sig`, a fingerprint of everything it asks;
  `answer(card, choice, sig)` must re-read the card live and refuse (`kind: "stale"`) unless it is unchanged, and must
  never answer a secret or a link request. The core checks the choice and the fingerprint first, and sends one answer
  per card as shown; report `maybeSent: true` when a reply was lost and the answer may have delivered.
- **`send(threadId, text, seed)`** sends a message into a thread as the Steward. Use `seed` to make a retry carry the same
  ids so the backend can drop the repeat.
- **`setTitle(title)`** renames the Decisions thread.
- **`transcriptPath()`** points at the Steward's Claude Code transcript for the health check (and may give
  `threadReadKey` so the check can count repeated reads of one thread).
- **`stewardProbe()`** returns `{ readable, contextTokens?, stalled?, compactBlocked? }` once a minute.
- **`handoffInstruction()`** returns the sentence the hand-off wake carries: how the Steward on this backend starts its own hand-off (T3: run `/steward-handoff`). With it, a HAND OFF verdict from the health check is a wake the daemon queues itself; without it the operator is asked instead (docs/steward-health.md).
- **`snapshot()`** returns a fresh read of every thread on the server, `{ complete, threads: [{ id, archived, settled, pendingRequestId, status }] }`, taken now over a connection of its own and never from the watcher's cache. It rejects when the server cannot be reached or the answer marks itself partial. Set `complete: true` only when your backend positively proves the list is whole; T3's shell stream gives no such proof, so the T3 adapter always says `false`. The held-ledger reconciler closes a Steward hold on a thread only from a complete snapshot: an unreachable server, a partial answer or an adapter without it leaves that thread unknown. A record it cannot read marks the snapshot `partial`: a thread missing from it is unknown, and a hold that names no server stays unknown while any snapshot that answered is partial or incomplete, since the unreadable record could be a second listing of the thread. Card holds always name their server and never read a snapshot.
- **`compact`** is a wake transport whose `send` takes no message.
- **`alertDesk`** is `{ wake, isBusy() }` for the Alert Desk's own thread: a second wake transport (a different webhook) and that thread's own busy
  gate. With it the core drains the alert inbox into wakes for the `desk` receiver and the one relay sends them to this transport, through its one serial queue (docs/alert-desk.md). The T3 adapter
  reads the `desk-wake-url` secret and `threads.desk` (`readPrivate("desk-wake-url")`, `readPrivate("desk-thread")`); without the URL `wake.ready()` is false and nothing is drained.
- **Wording**: `serverLine()` and `approvalHint` adapt the sentences a wake says about the server and about approvals.

## Testing an adapter

- `conformance(adapter)` in `src/core/adapter.ts` returns what is wrong with a declaration: a capability declared but not
  implemented, implemented but not declared, or a required part missing. Assert it returns `[]`.
- `src/testing/fake-adapter.ts` is a complete in-memory adapter and the smallest worked example; copy its shape. Drive
  the engine (`createEngine`) with it as `src/core/engine.test.ts` does, to see what a backend like yours would
  cause: a wake delivered, a report held while the Steward is busy and sent as one digest.
- Keep the network and the clock injectable, so a test drives your real code against a stub server. The T3 adapter's
  tests (`src/adapters/t3/*.test.ts`) fake the socket, the history pages and the state database.
- Put tests that need the registry in `src/adapters/` itself (see `registry.test.ts`), not inside your folder.

A worked sketch of a second adapter, for the terminal workspace manager herdr, is in [`examples/herdr-adapter.md`](../examples/herdr-adapter.md).
