# Roadmap

What comes after 0.1, in the order it is worth building, and the points where Chamberlain is meant to be extended. Nothing
here is promised; it is the plan the design is shaped around. Each item says what it is, who else wants it, and how big it is
(S: a few days of tested code, M: about a week, L: a few weeks).

## Where things stand

0.1 is a zero-model-call daemon and a decision-queue page behind an **adapter contract**, with **one SQLite database** for
all state and **one item system** for everything that is tracked, de-duplicated or re-notified ([ARCHITECTURE.md](ARCHITECTURE.md)).
That last part matters to this roadmap, because it removes the largest risk the plan used to carry:

- **A sweep check is an item source.** A finding has identity (a `dedup_key`), a repeat policy with a maximum, a mode (`silenced`, `shadow`, `live`),
  a `subject` (a pull request, a run, a deploy) and an error state, and one function decides when it notifies. A monitor with a
  ledger and an escalation policy is therefore not a second system to build: it is another `ItemSource` plus the policies
  below (a per-hour cap, an urgent bypass, one digest, offline versus error).
- **`shadow` mode is standard.** Every new check, gate and monitor can ship in `shadow` mode first: it records what it would have
  sent, in columns of its own, so going live never counts a would-be notification as sent.
- **State is one file**, so a move to another host, a backup and a conformance test of a new source are all small.
- **An architecture test fails if a second dedup or re-notification mechanism appears**, so the plan below cannot quietly grow a
  second one.

## Principles for everything below

- **The core owns the clock, the items, the cap, the digest and the wake text; a plugin only answers "what did you see?" as
  JSON.** Plugins are commands (as `sweep.json` already runs checks), not dynamic imports: that keeps the 0600-config trust
  model, is language-agnostic, and lets an operator keep a private collector outside the public repository without forking.
- **An error never reads as clear.** A source that cannot see reports an `evaluation_error`; a partial list (a full page, a rate-limited call)
  is an error, never a shorter list.
- **Authority features ship in audit.** Anything that can block or override defaults to recording what it would do, and fails
  closed when its configuration is unreadable.
- **Wake text is a template over the operator's name and the feature's own words.** No person, organisation or tool name is in code.

## 0.2: make `sweep.json` useful on day one

A user who installs 0.1 gets a clock and no useful checks. Most of 0.2 moves well-tested logic into built-in check types.

1. **Built-in checks and a repo provider (M).** Check types beside `command`: `machine` (free disk and load on a host), and, on a
   pull-request host, `pr-ready` (open, non-draft, approved at its current head, no changes requested, latest check runs
   green, mergeable), `pr-merged` (merged since the last sweep) and `fix-rounds` (a pull request through N rounds of review
   and fix, an alert only, documented as an approximation: committer dates stand in for pushes). They depend on a **repo
   provider** (below) backed by the host's own CLI or a token, never on a private wrapper. A `landing: "native" | "queue"`
   switch covers repositories where a merge queue or bot lands the change and the merge state reads "blocked" until then.
   Each finding carries a `subject` (the pull request), so a queue question about it can be matched exactly rather than by text.
2. **Host runner (S).** One way to run a command on a host named in `servers.json` (`sshHost`, `mayBeOffline`), where an ssh
   failure that is not an authentication error means *offline* (the host is asleep: no alarm) and anything else means *error*.
3. **Operating-rules from several sources (S).** `operating-rules.json` takes more than one source file and a table-with-header
   section form, so an excerpt can come from a shared file and a per-host file without a second copy to drift. Done: `sources` and the `table` selector (README, `operating-rules.json`).
4. **Quiet hours for alerts (S).** `settings.json` `quietHours` applies to `alertCommand` only, never to the Steward's wakes; an
   alarm raised in quiet hours is queued and sent when they end. Document that the alert command should de-duplicate on
   `CHAMBERLAIN_ALARM_KEY`.
5. **Brief fragments (S).** `brief.d/NN-name.md` in the config directory are appended, in order, to the Steward's hand-off,
   so project-specific procedure is configuration, and later features (gates, landing) can emit their own. Done, verbatim
   (no substitution) and in byte order of filename ([CONFIGURATION.md](CONFIGURATION.md), `brief.d/`).
6. **A tunnel template and a "moving to another host" guide (S).** One template unit `chamberlain-tunnel@.service` (and a
   launchd equivalent) driven by a per-server env file, whose important trick is idling quietly while a laptop sleeps; for
   tailnet users no unit is needed. State is one database file, so the guide is short.
7. **Wake policy as configuration (S).** Which wake kinds may be held, which are capped per hour, and which bypass the cap
   (`HOLDABLE_KINDS` becomes config), with `deliver(message, id, { kind, urgent })` carrying the urgency.

## 0.3: gates and monitors

1. **Gates (M).** A periodic verdict that can block an action, such as the Steward landing a change alone. A gate reads named
   rates from a source (an HTTP JSON endpoint with a bearer token from a 0600 file, or a command printing the same JSON),
   compares them to per-metric maxima, and keeps a status of pass, fail or no-data, with **hysteresis** (a failed gate passes
   again only when every gated rate is a margin under its threshold), **audit and enforce modes**, one wake per status change
   and one for a data outage. Fail-closed rules carry over: stale or absent data never passes a failed gate, an unreadable
   configuration counts as enforce, and a waiver never changes the status or hides an outage. The waiver is a
   **principal-attested override**: a decision-queue answer given on the page by the operator whose chosen label matches a
   configured pattern, verified against the queue, never the Steward's word. Expose that check (`attest`) so any human-only
   action uses one implementation.
2. **Landing check (S, with gates).** `land-check <branch>` runs every gate and any configured commands and exits 0 (ok), 1
   (something could not be read) or 3 (a gate blocks); the hand-off's landing section is rendered from it.
3. **Stability metrics from the pull-request host (S + S, L optional).** Revert rate (merged pull requests that revert one
   merged in the lookback) and change-failure rate (issues with a configured label that name a causing pull request) need
   only the repo provider. Rework rate (fix pull requests whose lines blame to a recent one) needs a local clone and is
   optional, behind its own switch.
4. **Monitors over items (M).** A monitor is an `ItemSource` that runs on its own interval, with the policies the item system
   does not yet have: a **per-hour wake cap with an urgent bypass**, **one digest per run**, **offline versus error**, optional
   **quiet hours** for alerts to the operator, an optional file **watch** that triggers a debounced run (near-instant reaction
   to a tool's state file without polling harder), and a **sources footer** on every wake built from trusted state ("a ok · b error
   since 15:40 · c offline"), so a source that is not ok is never summed into "all clear". First consumers: CI failed and CI
   cancelled events from the pull-request host.
5. **Adapter `listThreads()` (S).** An optional adapter method returning threads with their worktree path and branch, so a
   monitor can find "which thread works on this branch" without knowing a backend's tables.
6. **Steward health behind the adapter (M).** The context-size and rereading signals are useful for any long-lived agent. Move
   the Claude-transcript reader behind `adapter.transcriptPath` and a small registry of transcript readers, with thresholds
   in `health.json`. Without a reader it reports "unavailable", never "OK" (already the behaviour).

## Later

- Rework-rate by blame (above), behind a configuration flag.
- A second repo provider for another pull-request host.

## Extension points

Each plugin is a command speaking JSON; the interfaces are the core's view.

**Item source** (exists today, `src/core/source.ts`). Everything a monitor, a check or a gate reports goes through it.

```ts
interface ItemSource {
  readonly name: string;               // the item `source`: "check:disk", "runaway", ...
  readonly mode?: "silenced" | "shadow" | "live";
  run(): Promise<readonly Finding[]>;  // throwing means error
}
type Finding = { key: string; text: string; repeatIntervalMs?: number; maxNotifications?: number; baseline?: boolean; subject?: { kind: string; id: string } };
```

**Monitor** (planned): an `ItemSource` with an interval and the policies above.

```ts
interface MonitorConfig {
  name: string; mode: "silenced" | "shadow" | "live"; everyMs: number; maxWakesPerHour: number; urgentKinds: string[];
  quietHours?: { tz: string; from: number; to: number; appliesTo: "alerts" };
  errorAfter: number; errorAlarmMinutes: number; watch?: { path: string; debounceMs: number; minGapMs: number };
  sources: { name: string; command: string[]; host?: string; mayBeOffline?: boolean }[];
}
// A source command prints { ok: true, items: [{ dedupKey, kind, since, repeat, urgent, lines }] } and exits 0;
// exit 75 means offline, anything else (or bad JSON) means error.
```

**Gate** (planned): a periodic verdict that can block.

```ts
type GateStatus = "pass" | "fail" | "no-data";
type GateReading =
  | { ok: true; stale: boolean; metrics: Record<string, { numerator: number; denominator: number; rate: number | null }> }
  | { ok: false; reason: string };
interface GateConfig {
  name: string; mode: "audit" | "enforce"; blocks: string;          // "merge", "deploy", ...
  metrics: Record<string, { max: number | null; label?: string }>;  // null: reported, never gated
  hysteresis: number; evaluateEveryHours: number; outageAlertHours: number;
  waive: { optionPattern: string; maxDays?: number };
}
```

**Landing check** (planned): `{ gates: string[]; checks: { name; command: string[]; hosts?: string[]; onOffline?: "not-checked" | "block" }[] }`,
with `{branch}` substituted into each command.

**Repo provider** (planned): the pull-request host behind built-in checks and metrics.

```ts
interface RepoProvider {
  id: string;                                                         // "github" first
  listOpenPrs(repo: string, o: { base?: string }): Promise<Pr[]>;    // throws on a full, un-paged page
  listClosedSince(repo: string, since: string): Promise<Pr[]>;
  reviews(repo: string, n: number): Promise<Review[]>;
  commits(repo: string, n: number): Promise<{ parents: number; at: string }[]>;
  checkRuns(repo: string, headSha: string): Promise<{ name: string; status: string; conclusion: string | null }[]>;
  searchIssues(repo: string, q: { label: string }): Promise<Issue[]>;
  rateLimit(): Promise<{ remaining: number; resetAt: string }>;
}
```

Backed by the host's own CLI (already authenticated) or a token over `fetch`. Every method returns a partial result as an
error, so a check is in error rather than reading clear.

**Host runner**: `(host: string | null, argv: string[], input?: string) => Promise<string>`, the host resolved through
`servers.json`; errors carry a code, and an ssh failure that is not an authentication or host-key error is an `OfflineError`.

**Adapter additions** (optional, so a minimal backend is not forced to implement them): `listThreads?(server)` returning
`{ id, title, archived, worktreePath?, branch? }[]`.

## Cross-cutting risks

- **One item model, kept one.** The sweep and every future monitor share the item system, and `src/architecture.test.ts`
  guards it. The remaining risk is semantic: a source that reports its findings under unstable keys defeats de-duplication,
  and a repeat policy with no maximum is a pager. Review each new source's dedup keys and repeat policy like an API.
- **Authority features are not neutral.** Gates and waivers encode who may override whom. Default to audit, fail closed when
  the configuration cannot be read, and test "the waiver never hides missing data" before moving any code.
- **Plugin commands run as the user.** Keep the 0600 rule for `sweep.json` and for the files the plan adds (`gates.json`,
  `monitors.json`, `landing.json`), and keep command arrays, never a shell.
- **The pull-request host's cost.** Poll budgets and pagination guards are part of the contract, not an optimisation: a partial
  list must be an error. Prefer one GraphQL query per repository per poll to per-pull-request calls, cached by `updated_at`.
- **One database file is one point of failure.** It is the cost of one transactional store. Back it up, keep it on local
  disk (WAL needs shared memory, so not a network share), and treat a database newer than the code as a stop, as 0.1 does.
- **Do not over-generalise the metric source.** The HTTP JSON contract (`{ schemaVersion, windowDays, stale, metrics }`) is
  deliberately small; resist inventing a query language for it.
- **Wake text and the Steward's rules stay the operator's.** Every new feature that speaks to the Steward does so through a
  template over `{{principalName}}`, and nothing in it is decided by a model.
