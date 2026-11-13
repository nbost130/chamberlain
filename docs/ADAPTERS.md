# Writing an adapter

An adapter connects Chamberlain to one agent backend. T3 Code is the adapter that ships (`src/adapters/t3/`). This page
says what an adapter must do, how to add one, how to test it, and sketches a second one, for the terminal workspace
manager, herdr, without implementing it. Read [ARCHITECTURE.md](ARCHITECTURE.md) first for where the
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
3. Point a server at it in `servers.json`. `name` and `adapter` are the core's; every other key is yours:

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
  server: ServerEntry;                          // your servers.json entry
  conf: string;  state: string;                 // the config and state directories
  store?: Store;                                // the database, if you must remember something across a restart: key it by your own name
  log(event: string, data?: object): void;      // the event log (the database's events table)
  alarm(key: string, title: string, summary: string): void;   // a dead-man alarm: an item that notifies at most once per 6 hours per key
  steward(): string | undefined;                // the Steward's thread id, read fresh (it changes at a hand-off)
  readPrivate(name: string): string | undefined; // a mode-0600 file in the config directory, trimmed
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
again until the row's attempts (3 by default) are used, then keeps it as a dead letter (see the README's "Dead letters"). Do not retry
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

- **`inspect`** (`lastMessage`, `waiting`, `runningSubagents`, `instruction`) reads one thread when a wake is built. It may
  reject (the core logs it and goes on); `instruction` never rejects, it returns a state (`complete`, `truncated`, `failed`)
  that says whether "nothing to report" can be believed. Without `inspect` the core has no way to know who instructed a
  thread, so a turn end is reported once per turn instead of only for work the Steward sent.
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
- **`snapshot()`** returns a fresh, whole read of every thread on the server, `{ complete, threads: [{ id, archived, settled, pendingRequestId, status }] }`, taken now over a connection of its own and never from the watcher's cache. It rejects when the server cannot be reached. The held-ledger reconciler closes a hold on a thread only from this: an unreachable server, a partial answer or an adapter without it leaves that thread unknown.
- **`compact`** is a wake transport whose `send` takes no message.
- **`alertDesk`** is `{ wake, isBusy() }` for the Alert Desk's own thread: a second wake transport (a different webhook) and that thread's own busy
  gate. With it the core drains the alert inbox into wakes for the `desk` receiver and a second relay sends them (docs/alert-desk.md). The T3 adapter
  reads `desk-wake-url` and `desk-thread` from the config directory; without the URL `wake.ready()` is false and nothing is drained.
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

## Sketch: a herdr adapter

**This is a sketch, not an implementation.** herdr is a terminal workspace manager. Its socket API has `events.subscribe`
(a stream of events such as `pane.agent_status_changed`), `agent.get`, `agent.send` and `notification.show`, and an agent
status of `idle`, `working`, `blocked`, `done` or `unknown` (run `herdr api schema --json` for the exact shapes; the notes
below are checked against protocol 16). Requests are `{ id, method, params }` and answered by `{ id, result }`; `agent.list` answers with `{ type: "agent_list", agents }`, each agent carrying `pane_id`, `title`, `agent_status` and `cwd`.

The mapping, from the contract to herdr:

| Contract | herdr |
| --- | --- |
| a thread | an agent pane; `id` is the `pane_id`, `title` is the pane's `title` (or its agent name) |
| `status` | `working` → `running`, `blocked` → `waiting`, `done` → `completed`, `idle` → `idle`; `unknown` → report nothing (keep the last known status) |
| `watch` | connect to the socket, `events.subscribe` with `[{ type: "pane.agent_status_changed" }]`, and report each event as a `state`; on connect, `agent.list` for the first sighting of every pane |
| `needs_input` | falls out of the rules: a pane that goes to `blocked` is a thread that went to `waiting`. There is no request id, so none is given |
| `turn_ended` | `working` → `done` or `idle` is a live thread that ended |
| `failed` | herdr has no failed status, so this never fires; a pane that exits is the nearest thing and is out of scope for the sketch |
| `wake` | `agent.send { target: <the Steward's pane>, text: message }`. `ready()` is true when the Steward's pane id is known |
| `isBusy()` | the last `agent_status` seen for the Steward's pane (kept from the event stream, refreshed with `agent.get`): `working` or `blocked` → `busy`, `idle` or `done` → `idle`, `unknown` → `unknown` |
| `post` | `notification.show { title, body }`: a toast, so `where` is `"notice"`; the page is the live view |
| `listWaiting` | optional: `agent.list`, the `blocked` panes, as read-only `question` cards whose `why` is "answer it in its pane" |
| `answer`, `setTitle`, `send`, `compact`, `alertDesk` | omitted: herdr answers happen in the terminal, and there is no Decisions thread |
| `inspect` | omitted at first. `agent.read` could supply `lastMessage` from the screen, but herdr keeps no instruction history, so without `inspect` every top-level turn end is its own report |
| `transcriptPath` | optional: when the Steward is a Claude Code pane, `agent.get` returns its `agent_session` (a path or an id) |
| the Steward | the `steward-thread` file holds its pane id, as it holds a thread id for T3 |

The shape of it:

```ts
// src/adapters/herdr/index.ts  (a sketch: not built, not registered)
import type { Adapter, AdapterFactory, ThreadInput, WatchSink } from "../../core/adapter.ts";

const STATUS: Record<string, string | undefined> = { working: "running", blocked: "waiting", done: "completed", idle: "idle", unknown: undefined };

export const createHerdrAdapter: AdapterFactory = (env) => {
  const socket = String(env.server.socket ?? "");              // your servers.json key
  if (!socket) throw Error(`servers.json: ${env.server.name}: a herdr server needs socket`);
  let busy: "idle" | "busy" | "unknown" = "unknown";            // the Steward's last status, kept from events
  const call = (method: string, params: object) => rpc(socket, { id: crypto.randomUUID(), method, params });   // newline-framed JSON; see the schema

  const adapter: Adapter = {
    id: "herdr",
    capabilities: ["transcriptPath"],                           // plus whatever else you build
    async watch(sink: WatchSink, signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          // first sighting of every pane, then the stream
          for (const a of (await call("agent.list", {})).agents) sink.event({ kind: "state", thread: toThread(a) });
          sink.connected(true);
          for await (const ev of subscribe(socket, [{ type: "pane.agent_status_changed" }], signal)) {
            const status = STATUS[ev.agent_status ?? "unknown"];
            if (ev.pane_id === env.steward()) busy = ev.agent_status === "idle" || ev.agent_status === "done" ? "idle" : status ? "busy" : "unknown";
            if (status) sink.event({ kind: "state", thread: { id: ev.pane_id, title: ev.title ?? ev.pane_id, status } satisfies ThreadInput });
          }
        } catch (e) { sink.log("session-error", { error: String(e).slice(0, 200) }); }
        sink.connected(false);
        await Bun.sleep(1000);                                  // back off, as the T3 adapter does
      }
    },
    wake: {
      ready: () => Boolean(env.steward()),
      send: async (_deliveryId, message) => {
        await call("agent.send", { target: env.steward(), text: message });   // the text ends with the delivery id; a delivered outbox row is never sent again
        return { ok: true };
      },
    },
    isBusy: () => busy,
    post: async (item) => {
      await call("notification.show", { title: "Decision needed", body: item.title });
      return { ok: true, detail: "shown as a notification", where: "notice" };
    },
    transcriptPath: async () => { /* agent.get on the Steward's pane → agent_session → a path */ throw Error("sketch"); },
  };
  return adapter;
};
```

Things the sketch leaves to whoever builds it: the socket's framing and path (take it from herdr's config and
`herdr api schema`), reconnecting, what a restarted herdr does to pane ids, whether `agent.send` queues while the target
is `working` (the core holds wakes while `isBusy()` says busy, so it should not matter), and a conformance test with the
socket faked.
