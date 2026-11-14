# Steward health

The Steward is one permanent thread that compacts when its context grows. Chamberlain measures it once an hour,
from the Steward's own Claude Code transcript, so a slipping Steward is noticed before it costs decisions. It makes
no model call. On a HAND OFF verdict it starts the hand-off itself, once per native session, as an ordinary wake
through the outbox; an adapter that cannot say how its Steward hands off (no `handoffInstruction`) falls back to
asking the operator once per session through the decision queue.

## What it reads

- The active Steward thread, from T3's state database (`threads.steward` in `config.json` names it), mapped to
  its native Claude Code session id and project directory.
- That session's transcript, `<claude config dir>/projects/<project>/<session>.jsonl` (`CLAUDE_CONFIG_DIR`, default
  `~/.claude`). Only canonical rows count: sidechains and API request snapshots are skipped.

So health needs a Steward on the Claude Code provider. On any other provider the measurement is reported as
unavailable and the verdict stays WATCH; nothing else in Chamberlain depends on it.

## Signals and verdicts

| Signal | Meaning | Default limit |
| --- | --- | --- |
| context | tokens in the latest assistant usage snapshot (never a sum) | watch at 200 000, compact above 350 000 |
| rereading | the Steward reads its own transcript, or re-reads the same thread within ten minutes | 3 self-reads, or 4 repeat thread reads |
| format (optional) | replies a prompt hook graded as slipped | 3 slips in the last 20 replies |

All counters reset at the latest compaction. Verdicts:

- **OK**: nothing elevated and nothing unknown.
- **WATCH**: something elevated, or something could not be measured (unknown is never OK).
- **COMPACT**: context above the compaction threshold with healthy quality signals. The daemon sends a `/compact`
  to the Steward's compact webhook; no hand-off is needed.
- **HAND OFF**: a quality signal (rereading or format) is past its limit. Compaction does not fix that. The daemon
  starts the hand-off itself, at most once per native session: it queues one wake (kind `handoff`, delivery id
  `steward-handoff:<session>`) telling the Steward to run its hand-off now, with no question to you. The wake is an
  ordinary outbox row sent by the one relay, so a failed delivery is retried with the usual pause and, after the
  attempts run out, dead-lettered with the `wake-dead-letter` alarm; retry or cancel it with `chamberlain wakes`. The delivery id
  is the record that this session was told, so a restart, a compaction or the next hourly check never queues a second.
  This needs the adapter's optional `handoffInstruction` capability (how a Steward on that backend starts its hand-off;
  the T3 adapter has it). An adapter without it leaves the hand-off to you: one `only-you` question through `chamberlain ask`,
  at most once per session, recommending the `/steward-handoff` command, and nothing starts automatically.

The limits are `HEALTH_CONFIG` in `src/core/steward-health.ts`. They are heuristics, not validated measurements: rereads
are observable calls, not proof of confusion.

## The optional format signal

If you run a prompt hook that grades each of the Steward's replies, set `CHAMBERLAIN_HEALTH_FORMAT_PATTERN` to a regular
expression that matches the hook's `UserPromptSubmit` context. Its first capture group must start with `broke` for a
slipped reply and be anything else for a clean one. Without it the signal is off and is not reported as unknown.

## Use

`chamberlain steward-health` prints a read-only live report. The daemon checks each minute whether an hour has passed,
stores the verdict in the database (state record `steward-health`), and the decision page shows it with its age (stale after two
hours). On the question path, a failed submission is retried at the next hourly check; the queue tag
`steward-health:<session>` keeps a crash between `chamberlain ask` and the result write from asking twice.

## Tokens per wake

An optional metric, off until `stewardTokens` is on ([CONFIGURATION.md](CONFIGURATION.md)). It answers what the Steward spends per
wake and per sweep, going forward and back through history, without a model call: every assistant row of a Claude Code transcript already
carries the API's `usage` object.

**How a transcript is read** (`src/core/steward-tokens.ts`). The transcript is split at each turn-starting prompt into segments:

| Kind | The prompt that starts it |
| --- | --- |
| a wake kind (`turn_ended`, `needs_input`, `answer`, `digest`, `sweep`, `failed`, `steward-handoff`, `rights`, ...) | a wake, by its `[chamberlain] <kind>:` header (`[t3-wake] <kind>:` in transcripts from before the rename), recognised only at the start of the prompt or of T3's webhook envelope. The kind is a fixed list (`WAKE_KINDS`); a header naming any other word is stored as `wake`, so no transcript word reaches the database or a report. A sweep is `full` (time for a full supervision sweep) or `findings`. |
| `start` | the start prompt a new Steward gets (`docs/steward-start.md`) |
| `compact` | a `/compact` |
| `notice` | a turn T3 starts itself: a watched pull request's update, a delegated task's result |
| `message` | any other prompt: the principal's own message, or a report another thread sent. The transcript does not say which. |

Background-task notifications, Stop hook feedback, the skill body a slash command expands to, and compaction summaries continue the
segment in progress. Each row belongs to its parent row's segment (Claude Code links every row to the one before it), so a prompt written
while an earlier request is still running takes none of that request's rows. A segment sums `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens` over its
distinct model requests (a request written as several rows, one per content block, counts once), and records the context (input plus cache
read plus cache write) at its first and last request. Sidechains (subagents) and API request snapshots are not counted, so a wake's figure is
the Steward's own thread, not the agents it spawned. A compaction's own summarising request is not in the transcript and is not counted.

**Storage.** One row per segment in `steward_wake_usage`, keyed by (session, delivery id); a wake from before delivery ids, and any prompt
that is not a wake, is keyed by its row's uuid. No text is stored. Rows are upserted, so the backfill can run any number of times and the
open segment of a live transcript is rewritten in place as it grows.

**Collection.** With `stewardTokens` on, the daemon re-reads the current Steward's transcript hourly. When the Steward has changed since the
last run it reads the previous transcript once more, so a hand-off loses none of the old session's last hour. A previous transcript that
cannot be read is kept and tried again on the next run until a read succeeds or the file is gone, and each failure is logged as
`steward-usage-error`.

**History.** Chamberlain keeps no list of past Steward sessions: `switch-steward` overwrites `threads.steward`. Every Steward of an install runs
in the same Claude Code project folder, so `chamberlain steward-health tokens backfill` reads every transcript there that received a wake
(`--dir <folder>` for another folder, or name transcript files). It takes seconds for a few hundred sessions.

**Report.** `chamberlain steward-health tokens` (`--json` for the numbers) shows, for the last 24 hours and the last 7 days: totals by usage
field; per kind, the number of turns, the median and p90 tokens per turn, the median and p90 requests per turn and the median context at the
start; the cost of a full sweep wake; and the context trend per session: context at the first and latest wake, the peak, and the growth per
wake since the last compaction, with how many wakes are left at that rate before the compaction line (`compactTokens`). A context that grows
steadily wake over wake is the signal to compact or hand off. The cost of a wake is roughly its requests times its context, so both are shown.
