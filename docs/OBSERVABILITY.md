# Observability: one log, one store, one question

**Status: B1 is built** (issue #20: `obs.db`, the event registry, the typed logger, redaction, the dual write and the reconciler; section 11 says what it settled where this design was open). B2 to B8 are design only. Written 2026-11-14 for Nathan, who asked for one logging and metrics approach that
answers **"Is our token spend producing valuable outcomes at an efficient rate?"** Every metric below names the change it
should trigger; a metric with no lever is not added. No model runs in the logging, collection, metric or report path (R98).
Counts below were read on 2026-11-14 at about 09:00 EST and drift.

## 1. What exists today

| Piece | Where it lives | What it holds | Problem for the question |
| --- | --- | --- | --- |
| Event log | table `events` in `chamberlain.db` (`log.ts`, 47 call sites in `engine.ts`, about 150 overall) | 17,202 rows, 2.27 MB, 2026-11-05 to 11-14; free-form `data` JSON | No level, host, thread or wake column. 46% of rows (7,904) and 35% of bytes are `session-error` for one unreachable server. `delivered` rows carry the full ~300-character T3 delivery id; `fire` rows carry thread titles. Pruned flat at 90 days. |
| Daemon log | journald, `chamberlain.service` | 13 lines in 24 h: start and stop only | Nothing to learn. `CHAMBERLAIN_VERBOSE` mirrors events to stdout as JSON. |
| Heartbeat, steward health | state rows `heartbeat` (each minute), `steward-health` (hourly) | Latest connectivity, away flag, context size, verdict | Snapshots, no history. |
| Decision ledger | table `decisions` (`decided.ts`), 1,243 rows | `t, thread, decision, ruling, ruling_ids, ref`, all free text | No wake id and no cost: cannot say which wake produced a decision. |
| Holds, rulings, queue | `held_wakes`, `items` (sources `held` 363, `queue` 236, `notification-log` 602), `rulings` (100) | State of record. A queue item already stores `recommended` and its answer stores the choice and a time (231 answered; 229 had a recommendation; 199 matched it; measured by the Sol review) | The data exists but only as item payloads; nothing exposes ask time, answer time or "picked the recommended option" as fields. |
| Steward tokens (PR #12, open; renumbering to migration 14 because #14 took 13) | table `steward_wake_usage` in `chamberlain.db`, hourly in the daemon | Tokens and requests per Steward wake, from its transcripts | Steward only; sums requests without model or cache-write TTL; skips sidechains (subagents were 7% of spend). |
| Classifier dispositions (#14, merged `f6d49eb`) | table `thread_dispositions` (migration 13), edited later | One row per classification: provider (`rules`, `jev`, `haiku`), model, mode (`shadow`, `live`), action, `reasons` (bank question ids with probabilities), `sent_chars`, `redactions`, `input_tokens`, `cost_usd`, `latency_ms`, `error`, and `feedback`/`corrected_action` (nothing writes those yet: #19) | The only model spend not in a transcript, so no transcript reader sees it. Input tokens only; `cost_usd` is a fixed rate for Jev and the CLI's own figure for Haiku, so it cannot be repriced. `error` is exception text. Rows change when a label arrives, so it is not append-only. |
| Usage log (issue #16), scorecard (#15) | not built | 15-minute plan utilization; four buckets per merged PR and week | #15 needs every thread's spend, which only transcripts hold. |
| One-off report | `~/.local/state/chamberlain/reports/subscription-efficiency-2026-11-14.md` | 14 and 30 day spend, model mix, sinks | Mithrandir only (Omar has 816 transcripts, the Mac did not resolve); one overwritten utilization snapshot; no thread-to-PR join beyond directory names. |
| LifeOS `UsageAggregator.ts` | Mac launchd, nightly | Per-day totals by model, rebuilt from raw transcripts | No session, thread or PR. Its header says transcripts are pruned in about 5 days; this host's reach back to Oct 14, so retention differs per host. Reuse its pricing (cache-write TTLs, de-dup by `requestId`). |

Not a source: LifeOS files such as `codex-runs.jsonl`. Chamberlain is standalone; it reads the CLIs' own files, as the aggregator does.

## 2. One store, one event schema

**Store: a new `obs.db` beside `chamberlain.db`, same state directory, WAL.** Ledgers stay in `chamberlain.db` as the system of
record; all telemetry lives in `obs.db`, and **every telemetry migration is `obs.db`'s own**, so an older daemon never refuses the
ledger because of a metrics change (#12's deploy-order problem). Pre-deploy backups copy `chamberlain.db` (10 MB each, three
already) and do not grow with telemetry; retention and `VACUUM` never touch ledgers.

**Ledger to events, without a shared transaction.** The ledger is the truth and events derive from it. Every derived event has a
stable `source_key` (`decision:1243`, `item:<id>:asked`, `item:<id>:answered`, `hold:<delivery>:closed`), unique in `events`. The
code that writes a ledger row also emits its event inline with `INSERT OR IGNORE`; a reconciler (at start, then hourly) opens
`chamberlain.db` read-only and emits any ledger row whose key is missing. A crash between the two loses nothing and a
retry duplicates nothing. The one-off backfill of 1,243 decisions and 231 answered questions is the same reconciler. Historical
events have no `corr` and are marked `corr = NULL`, never guessed.

**Mutable ledger rows.** A row that is edited later (`thread_dispositions` gets its label from `dispositions mark`) is a fact, not an
event. The reconciler upserts it into `obs.db` as `disposition`, keyed `(server, thread, message_hash, bank_version)`, holding only typed
fields (`provider`, `ModelName`, `mode`, `action`, reason ids as an `Enum`, `idle_minutes`, `sent_chars`, `redactions`, `input_tokens`,
`cost_usd_micro`, `latency_ms`, `error_class`, `feedback`, `corrected_action`), plus `classified_at` and `answers` (a map of bank question id, validated
as an `Enum`, to a permille `Int`). `rev` is a hash of every projected field, because a retry (`put`) and `redecide()` change action, reasons and cost as well as labels. The
ledger has no revision of its own, so every reconcile re-reads the row and the next pass corrects a stale write; one in-process lock serializes them. `mark` writes the
ledger, then reconciles that key; if that fails, the hourly pass converges it and the report prints the fact's age. The `error` text is mapped to `errClass` and
dropped. The ledger holds only per-action labels, so agreement is **per action**; per-question accuracy needs question-level labels that do not exist yet (#19's "per question" is out of reach until they do).

| Table | One row per | Key columns | Keep |
| --- | --- | --- | --- |
| `events` | thing that happened | `id, t, level, host, run, mod, event, corr, delivery, thread, source_key, data` (JSON, validated) | `info`+ 90 d; `skip-*`, `pipeline-*` and repeats 14 d raw |
| `event_daily` | day, host, event, level | `n, bytes` | forever |
| `usage_turn` | prompt-to-prompt segment of a transcript, per model | `host, session, turn_key, model, rev, thread, corr, role, bucket, repo, pr, t_start, t_end, requests, input, cache_read, cache_write_5m, cache_write_1h, output, ctx_first, ctx_last` | 45 d |
| `usage_week` | week, host, thread, role, bucket, repo, pr, model | the same sums plus `turns` | forever (about 10k rows a year) |
| `plan_usage` | observation of a plan window | `provider, account (hash), window, resets_at, observed_at, source, fresh, pct, overage` | 400 d |
| `disposition` | classification (fact, upserted) | the key above plus the typed fields | 400 d |
| `outcome` | merged PR, closed issue, release | `repo, kind, ref, merged_at, weight, fix_rounds, blockers, reverted_by, regression_of` | forever |
| `obs_cursor` | transcript file | `host, path, inode, head_hash, offset, rev` | while the file exists |

Tokens are stored, never dollars. `prices.json` ships with the release, with `effective_from` per model and cache-write TTL; the
report prices each turn at the price in force on its date, shows a model with no price as **unpriced** (not zero, and out of the
headline), and shows every report's `price_version`. A price change never silently moves history. Classifier rows carry their own recorded `cost_usd`;
it is shown at face value and labeled `recorded`.

**Plans are config, never code.** `plans.claude = "max-20x"` and `plans.codex = "pro"` (Nathan, Q-hlc5v582c) are labels the report prints; each plan's monthly price is `planPriceUsd.claude` / `planPriceUsd.codex`, empty by
default, and no price appears in code or in `prices.json`. **Share of plan** comes from the `plan_usage` window percentages (mean and peak of each window, time at or above 90%) and needs no price. Dollars are
always API list price, labeled. Only when a price is set does the report add "list-price value per plan dollar". Codex has no list-price row today, so its spend shows as tokens and share of plan, not dollars.

**Correlation, stated precisely.** `corr` is a 12-hex digest (`corrOf()`) of an *id the code already has*; there is no single id
from sighting to answer, because the engine creates a delivery id after deciding and composition makes a new one.

| Link | Id | How it is joined |
| --- | --- | --- |
| Candidate wake (a held row) | `corr` of its own delivery id | `wake.held` |
| Composed digest | `corr` of the digest's delivery id | `wake.composed` lists `members` and `kept` corrs; a folded member is marked folded (`hold.ts` keeps `members`, `kept`, `folded`) |
| Steward's turn | the digest's `corr` (the wake header carries the delivery id) | `usage_turn.corr` |
| Question and answer | `corr` of `item:<id>`; the answer wake is `answer:item:<id>` | `question.asked`, `question.answered`, and the turn of that answer wake |

A digest's cost is counted **once**, on its delivery. A per-thread coordination view splits it evenly across kept members and
says so; it is an allocation, not a measurement. `delivery` stores the digest, never the raw id. `thread` is the T3 thread id,
never a title. `run` is a per-daemon-start id.

## 3. The logging API (every module, one import)

```ts
const log = obs.child({ mod: "relay", thread, corr });          // bind once per wake
log.info("wake.delivered", { http: 202, attempt: 1 });          // fields typed by the registry
log.change("server.mac", "down", { err: errClass(e) });         // writes on a transition, plus a suppressed count
log.warn / log.error / log.debug                                 // debug is not stored unless CHAMBERLAIN_LOG=debug
```

| Level | Meaning | Stored |
| --- | --- | --- |
| `debug` | developer detail | no, by default |
| `info` | a state change or countable fact (a wake, a skip, an answer) | yes |
| `warn` | degraded, recovered or recoverable | yes; counted in the heartbeat |
| `error` | needs a person or loses data | yes; counted in the heartbeat and the report |

**Redaction by construction; no free text, anywhere.**
1. *Allowlisted schema, enforced at runtime.* A registry declares each event's fields with opaque types: `Uuid`, `Hex12`, `ItemId`,
   `ModelName`, `Enum[...]`, `Int`, `Ms`, `Bool`. There is no `string` and no `note`. An error is `errClass(e)` (an enum such as
   `ECONNREFUSED`, `timeout`, `http-4xx`), never its message. A thread title, a path, a URL and a prompt can be neither written nor spooled.
2. *The same schema validates every spool row and every ingest row*, per table, with unknown columns rejected, so a buggy
   collector cannot put text in the store. The spool directory are `0700`, files `0600`.
3. *A scrubber backstop* drops keys matching `token|secret|authorization|cookie|password|apikey` and values shaped like `Bearer …`, a
   JWT, `sk-…`, `gh[pousr]_…` or the page key. Each hit increments `log.redacted`, which must read zero: a hit is a bug and shows on the report.

An unknown event or field is dropped and counted (`log.rejected`), never thrown. A failed write is counted and printed at most once a
minute; a log call never blocks or fails its caller. A CI test fuzzes every registry event and every table with secret-shaped values.
**Noise.** `log.change` replaces the 7,904 repeated `session-error` rows with one row per outage.

## 4. The metrics layer (SQL views over `obs.db`, no model)

**Buckets (R100).** A spend row's bucket, in order: (1) a `bucket: building|assurance|coordination` line among the first lines of the delegation brief, read from the session's first
prompt by regex (until the parser lands, briefs are `unclassified` and that share is shown); (2) the Steward, Alert Desk and Decisions thread ids from config → `coordination`; (3) the thread's `delegate_task`
role when T3 records it (`implementation` → `building`, `review` → `assurance`); (4) else `unclassified`. Spend reaches a PR by
worktree branch → PR head branch; the rest is **unattributed**, and both shares are metrics.

| Bucket | Cost | What it produced, and how it is derived without a model |
| --- | --- | --- |
| Building | builder tokens, wall time | merged PRs by kind from the conventional-commit prefix of the title |
| Assurance | reviewer and gate tokens | blockers from a one-line trailer in each review comment (`<!-- review: verdict=hold blockers=6 -->`); fix rounds = groups of pushes after a trailer or a `CHANGES_REQUESTED` review, from the PR timeline; regressions = a `fix` PR merged within 7 days whose body or branch names an earlier PR of the same repo (a proxy, labeled), reverts = revert PRs and commits |
| Coordination | Steward, desk, Decisions tokens, per wake kind, plus the classifier's billed cost, summed from one inline `classifier.attempt` event per billed call (the ledger keeps only the last attempt's `cost_usd`, so it would undercount); rows with unknown cost are counted and shown | an *empty wake* = a turn with no `decision.logged`, relay or post inside its window |
| Nathan's attention | not dollars: questions, time to answer, recommended-picked rate, already-settled rate, interruptions | `question.asked` and `question.answered`; *already settled* = the existing settled matcher (`settled.ts`) finds an in-force ruling at answer time; *interruption* = a `message` turn in the Steward thread, a **proxy that also counts builder reports** until B3 can split by sender |

**Headline.** `outcome points ÷ API-list-price spend`, weekly, with a 4-week median, always printed with raw counts, priced coverage
and hosts reporting. Points: one per merged PR at its kind weight (config `outcomeWeights`, default `feat` 3, `fix` 3, `docs` 1, `chore` 0.5, any other kind 1; printed beside every weighted number); an issue closes for a point only when no merged PR links it;
a release adds one point and its release-please PR adds none; a regression or revert subtracts the weight of the PR it undoes. A week
is **provisional** until 7 days after its last merge and **partial** when under 90% of tokens are priced or a host is missing; a partial
week prints no ratio. Splitting work to farm points shows up in the raw counts beside the points.

| Metric | Bucket | Lever when it moves |
| --- | --- | --- |
| Opus turns under 150 output tokens (14 d report: $443, 11% of Opus); a candidate list, not proof | any | review the list, move that lane to Sonnet or Haiku |
| Fix rounds per PR, above 2 | building | tighten the brief or the review |
| Reviewer $ per blocker; PRs reviewed with zero blockers | assurance | cheapen or drop review for that change class |
| Reverts and regressions within 7 days ÷ merges | assurance | strengthen the gate for that kind |
| Empty-wake share | coordination | put code or the classifier (#14) in front of the wake |
| Classifier agreement with labels, per action and provider (`feedback`; needs the ~100 labels #19 collects) | coordination | promote shadow to live where it agrees; drop a provider that does not |
| Classifier net, from the live rules (`idle-parents.ts`: `escalate`, `nudge`, `unknown` still report, `settle` folds into the day's digest line, `ignore` is dropped): `ignore` count × the measured cost of an empty wake, plus a smaller credit for `settle`, minus the classifier's billed cost. In shadow it is labeled **estimated** | coordination | keep `jev`, `haiku` or `rules` only; turn it off if the net is negative |
| Coordination share of spend (start alert at 30%, tune after 4 weeks; 14 d report: orchestration 40%) | coordination | hand off or shrink standing threads |
| Steward context at wake, wakes left before compaction | coordination | hand off earlier |
| Questions answered with the recommended option | attention | turn that question class into a ruling |
| Already-settled questions | attention | fix the settled check |
| Median time to answer, questions per merged PR | attention | batch, or lower the tier that asks |
| Share of plan (mean and peak window utilization) and time at or above 90% (sampled estimates) | cap | shift load to idle days or another plan |
| Unattributed, unclassified and unpriced shares (target under 10%) | data quality | tag at source |
| Anomaly: the 3 costliest threads of the week with no merged outcome, linked | all | look at those three |

Not measured, and not claimed: regressions avoided, attention saved in minutes, and anything about quality of judgment.

## 5. One reporting surface

| Surface | What | Rule |
| --- | --- | --- |
| `chamberlain report [--weeks N] [--json] [--bucket B]` | headline, buckets per PR and per week, the table above with value, trend and lever, the anomaly line | read-only SQL; exits 0 on partial data and names the gap |
| `/report` on the existing page server | the same JSON rendered, per-host "data through" stamps, a flag where a threshold is crossed | same auth as the page; no write endpoint; thread links resolved live, titles never stored |
| Weekly wake | once a week, one Steward wake (kind `report`) of at most 10 lines: the three metrics furthest past their thresholds, each with its lever, and the `/report` link | text composed by code from the report JSON, sent through the existing outbox; its own cost shows as coordination spend |
| Never | the report itself in any thread, an email, a push notification | |

## 6. Collection from three machines

`chamberlain collect` (a one-shot in the release binary, `scripts/build.ts`) runs on **each host** from a user timer every 15 minutes
under `Nice=19`, idle IO and a 10% CPU quota (launchd: `Nice`, `LowPriorityIO`). It is deferred, never skipped. It needs no network: a host only spools locally and never pushes.

1. **Read.** Claude Code transcripts (honoring `CLAUDE_CONFIG_DIR`, including `subagents/`, as `role=subagent`) and Codex rollouts. Claude de-dupes by request id; Codex rollouts carry cumulative counters, so the reader takes deltas. Per request it keeps model and the cache-write TTL split before summing into a turn.
2. **Resume correctly.** A late duplicate row or a queued prompt can change an earlier turn (the cause of #12's review blockers 3 and 5), so the cursor is the start of the previous two turns, a bounded replay, and an incomplete last line waits for its newline. Rows carry a monotonic `rev`; ingest keeps the higher one. A changed inode or head hash re-reads the file. The cursor advances only after the spool row is fsynced.
3. **Spool.** Each run that produced rows seals one immutable gzipped NDJSON chunk under `spool/` (at most 4 MB and 50k rows; a larger run splits), named `<host>-<utc>-<seq>` with a `.meta` of its length and sha256, written by temp-file plus rename. A chunk is never appended to. It is deleted only by `collect --ack <name>:<sha256>`, which checks the hash. One lock file per host stops overlapping runs. Cap: 20 MB per host and 90 days; past either, the oldest unacknowledged chunks are dropped and one durable `spool.lost` row (count, bytes, time range) goes into the next chunk.
4. **Plan utilization** (#16): one row per account, window and 15-minute slot. The source is recorded (`endpoint`, or a stale cache/rollout read); a stale read is stored but excluded from "time at or above 90%", and a missing slot is unknown, never carried forward. The account id is the provider's own account id, hashed, so hosts sharing an account de-duplicate.

**Pull, over the ssh Mithrandir already has** (no new key, no push). Config `collectHosts`: `omar` as `ssh omar`, and the Mac as `nbost@nathans-macbook-air`, each with the
absolute path of its `chamberlain` binary (a non-interactive ssh shell does not have it on `PATH`). On its own 15-minute tick Mithrandir collects its own spool, then for
each host runs `ssh -o BatchMode=yes -o ConnectTimeout=5 <host> <bin> collect --manifest` (chunk name, length, sha256) and then `collect --emit <name>` for at most 5 chunks, all under
one `timeout 60` that kills the process. The receiver accepts only a name matching `^[a-z0-9._-]{1,80}$` that the manifest listed, reads exactly `length` bytes, and
rejects a chunk over its limits, with a hash mismatch, or holding a row whose `host` is not the configured name or that fails the table schema (the remote is untrusted).
A good chunk is ingested in one transaction by `(host, session, turn_key, rev)`, then `--ack <name>:<sha256>`. A short stream, a timeout or a rejection gets no ack and
the chunk stays; a crash between commit and ack re-pulls the chunk and ingest ignores it. An unreachable host is one `log.change` transition, never an error loop. Timers on the Mac and Omar are user-level units. Outcomes (PRs, issues, releases, reviews, reverts) come from
GitHub through the daemon's existing `gh` setting, hourly, from Mithrandir only.

| Failure | What happens |
| --- | --- |
| Mac or Omar off or unreachable | no spend there; Mithrandir pulls at the first tick after it is back; the report prints "mac: data through <t>" and never zero-fills |
| Timer or binary broken on a host | the report flags any host silent for over an hour that has reported before; the collector also logs its own `collect.run` (CPU ms, bytes read) |
| Mithrandir offline, or a pull, hash check or ack fails | the host keeps every unacknowledged chunk until the byte or age cap, then `spool.lost` records the loss durably and the next pull shows it; no ack follows a failure |
| Transcript pruned before collect | a gap; recorded as a gap when the oldest remaining file starts after the last cursor |

## 7. Migration and the reshape of #12, #15, #16

| Today | Becomes | Step |
| --- | --- | --- |
| `events` in `chamberlain.db` | `events` in `obs.db` | release A dual-writes with `source_key`; a reconciliation proves counts and keys match; release B moves `afk.ts` and `queue-waits.ts` (which parses raw delivery ids) to the new API with the same semantics; release C drops the old table |
| `session-error` and other repeats | `log.change` plus `event_daily` | release A |
| heartbeat, `steward-health` | stay as live state, plus `warn`/`error` counts and an event per verdict change | release A |
| `decisions`, holds, rulings, queue answers | stay in `chamberlain.db`; events derive by `source_key` | release A, with backfill |
| `steward_wake_usage` (#12) | `usage_turn`, `role=steward` | reshape #12 below |
| usage-cache snapshot, #16 | `plan_usage` | built by the collector |
| the 2026-11-14 report | `chamberlain report` | after B3, B4 and B6; the file stays as the baseline |
| UsageAggregator | untouched; no dependency either way | |

**#12**: #14 now holds migration 13 and #12 is moving to 14, so merge it as it is (reviewed, additive, off by default) instead of holding it
for `obs.db`; its source is the transcripts, so merging early or late loses nothing. B3 reuses its reader and segmenter, adds model, cache-write TTL,
sidechains and the bounded replay, and writes `usage_turn`. `steward_wake_usage` and the daemon pass become legacy; B8 drops them (one more
`chamberlain.db` migration, accepted). B3 moves `steward-health tokens` onto `usage_turn` with a parity check against the old table on real transcripts; B8 drops the table only after that passes.
**#14 and #19**: the table stays a ledger in `chamberlain.db`. `dispositions list` and the evaluation summary read the `disposition` fact through the
same `obs` query API as `report`; only `mark` writes the ledger. No change to #14 is required; recording output tokens would be a useful one. **#16**: `plan_usage` and the fields above, in `collect`, no JSONL.
**#15**: shrink to the metric views and `report`; its bucket tagging is now B3 and B5; its surface is `/report`, not the Decisions page.

## 8. Overhead (estimates until measured; each budget is an acceptance test)

| Resource | Estimate | Budget and guard |
| --- | --- | --- |
| Log write | one prepared INSERT; 1.9k rows a day today, about 1.0k after the noise fix | p99 under 1 ms in a CI benchmark; write errors never reach the caller |
| Collector CPU | stat plus appended bytes plus a two-turn replay; 96 runs a day | CPU seconds per run (not elapsed) logged and budgeted at 2 s; over 10 s is a `warn` |
| Disk | events about 165 KB a day after the fix, about 12 MB at 90 days; `usage_turn` volume unmeasured (Steward alone made 12,003 requests in 7 d) | `obs.db` under 60 MB with indexes and WAL, `spool` under 20 MB a host ; the retention job shortens raw retention (floor 14 d) when over, an alarm alone is not enforcement |
| Tokens | zero in logging, collection, metrics and report | the weekly wake (section 5): one wake, about 540k total tokens (PR #12's `answer` median, mostly cache reads), about $0.20 at the report's blended Opus rate |

## 9. Build pieces, and what only Nathan can decide

| Piece | Issue | Needs |
| --- | --- | --- |
| B1 `obs.db`, schema, registry, logger API, validation, noise fix, dual-write, reconciler | new | |
| B2 retention, rollups, `chamberlain logs` (tail, by corr, by thread) | new | B1 |
| B3 `collect`: readers, replay, spool, `--emit`/`--ack`, pull and ingest, bucket classifier | new | B1 |
| B4 plan utilization | #16, reshaped | B3 |
| B5 outcomes (gh), attention events, fix rounds, regressions, `disposition` facts | new | B1 |
| #19 dispositions `list`, `mark`, evaluation summary | existing; reads through `obs` | B1, B5 |
| B6 metric views, `chamberlain report` and the weekly wake text | #15, reshaped | B2, B3, B4, B5 |
| B7 `/report` page | new | B6 |
| B8 cutover: readers to `obs.db`, reconciliation proof, drop old `events` | new | B1 to B6 |

**Decided 2026-11-14 (Steward, for Nathan).**

| Item | Decision |
| --- | --- |
| (a) outcome weights | the proposal, as a config default (`outcomeWeights`) printed beside every weighted number; reversible |
| (b) Mac and Omar | pull over the existing ssh; user-level timers; no new key, no push (section 6) |
| (c) plan tier and price | answered (Q-hlc5v582c): Claude Max 20x, Codex Pro, no prices. Tiers are `plans.*` config; prices are `planPriceUsd.*`, empty, never hard-coded; the report shows share of plan from window percentages and API list-price dollars, labeled (section 2) |
| (d) weekly wake | yes, one a week: top 3 changes plus the link (section 5) |
| (e) `bucket:` line and review trailer | yes; the Steward uses them once the parsers land (B3 for the line, B5 for the trailer) |

## 10. Review log (Sol, reasoningEffort high: hold, 12 findings, all folded)

Folded: free text and short secrets in redaction; ledger-to-event atomicity (`source_key`, reconciler); correlation across fold and answer; replay and cursor state; per-model pricing facts; stale
plan reads; the false loss bound; metrics without a source; the gameable headline; understated attention data; migration ownership and order; unmeasured overhead.

Addenda, 2026-11-14: #14, #12 and #19 added to sections 1, 2, 4, 7, 9; the Steward's decisions applied (sections 4, 5, 6, 9). The plan tiers Nathan answered are in section 2. A Sol delta check on those (high) held with 1 blocker and 6
should-fix findings, now folded: chunked, hash-framed pull and ack; receiver limits and deadline; a byte cap on the spool; a full-field `rev` for mutable facts; live-rule classifier savings from
per-attempt cost events; the `steward-health tokens` cutover. Not re-checked by Sol.

## 11. B1 as built (issue #20)

Code: `src/core/obs/` (`fields.ts` the opaque types, `errClass`, `corrOf`; `registry.ts` the events; `scrub.ts` the backstop; `row.ts`, `obs.ts`, `logger.ts` the logger; `db.ts` the file and its migrations;
`ledger.ts` the derived events and the reconciler) and `src/core/log.ts`, the one import (`logFor(store)`, `obsFor(store)`). Where the design was open or the code showed otherwise:

- **The old call stays, read through the registry.** About 120 call sites say `log("fire", { server, title, threadId })`. Each still does, and each of the registry's events names the old name (`legacy`) and
  the old key each typed field is read from (`from`, `via`): `delivered` is `wake.delivered`, `composed` is `wake.composed`, `deliver-held` is `wake.held`. What the registry does not name (a title, an error's text) is
  left in the old `events` table and never reaches `obs.db`. New code calls `obs.child({ mod, thread, corr }).info("wake.delivered", { http: 202 })`, which is strict: an extra field is rejected and counted. An event name no one registered is counted
  as `log.rejected` and still reaches the old table; a test fails if a call site names an unregistered event.
- **Dual write.** Every line is also written to the old table with the same `source_key` as `import_key`, so release B's reconciliation can compare the two. The old table keeps the full line (release C drops it).
- **`hold:<delivery>:closed` is `hold:<handle>:closed`.** A hold (a `held` item) has no delivery id; its own 8-hex handle is its key. `question.answered` also covers a question answered on its card (`by: "card"`).
- **`log.change`.** `session-error` becomes one `server.state` row per outage (the old table's `session-error` line too); the `connected` that ends it writes the matching `up` row with the number of repeats suppressed. First connect, no row.
- **Correlation.** `wake.composed` lists `members` and `kept` as corrs; its `corr` and `delivery` are the digest's; an answer wake (`answer:item:<id>`) takes the corr of its question. Rows the reconciler writes have `corr = NULL`; a row younger than a minute is
  left to its writer, whose inline emission carries `corr`.
- **A thread is stored only as a UUID** (T3's thread ids are). Anything else is dropped and counted; a decision's `thread` (free text, whatever the Steward typed) is left out silently.
- **Names the operator picks** (server and receiver names) are `Known` sets the engine and the page fill from servers.json; a name that was not registered is rejected like any other bad value.
- **Hot path.** `synchronous = NORMAL`, `busy_timeout = 0` (a held lock makes the row wait in a 500-row buffer; the oldest is dropped and counted when it fills) and `wal_autocheckpoint = 0`: SQLite's own checkpoint ran inside whichever INSERT crossed 1,000 pages and put p99 at 3 ms,
  against 0.09 ms without it. The hourly pass checkpoints instead.
- **After commit.** `store.afterCommit(fn)` runs the inline emission once the outermost transaction has committed and never on a rollback, so no event exists for a row that was not written.
- **Left for B2 to B8.** `host` is on every row (B3 fills it for pulled rows); a new event is one registry entry, a new derived key shape one line in `SOURCE_KEY` (`obs.ts`), a new transition family one entry in `FAMILIES`, a new table one entry in `OBS_MIGRATIONS` (`db.ts`).
  Not done here, because they belong to later pieces: retention and `event_daily` (B2), `chamberlain logs` (B2), `plans`, `planPriceUsd` and `outcomeWeights` config (B4, B6), moving `afk.ts` and `queue-waits.ts` to the new API (B8).

