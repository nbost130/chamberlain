# Steward health

The Steward is one permanent thread that compacts when its context grows. Chamberlain measures it once an hour,
from the Steward's own Claude Code transcript, so a slipping Steward is noticed before it costs decisions. It makes
no model call, hands off nothing by itself, and asks the operator once per session through the decision queue.

## What it reads

- The active Steward thread, from T3's state database (`steward-thread` in the config directory names it), mapped to
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
- **HAND OFF**: a quality signal (rereading or format) is past its limit. Compaction does not fix that. Chamberlain
  raises one `only-you` question through `ask.ts`, at most once per native session, recommending the
  `/steward-handoff` command. Nothing starts automatically.

The limits are `HEALTH_CONFIG` in `src/core/steward-health.ts`. They are heuristics, not validated measurements: rereads
are observable calls, not proof of confusion.

## The optional format signal

If you run a prompt hook that grades each of the Steward's replies, set `CHAMBERLAIN_HEALTH_FORMAT_PATTERN` to a regular
expression that matches the hook's `UserPromptSubmit` context. Its first capture group must start with `broke` for a
slipped reply and be anything else for a clean one. Without it the signal is off and is not reported as unknown.

## Use

`bun src/steward-health.ts` prints a read-only live report. The daemon checks each minute whether an hour has passed,
stores the verdict in the database (state record `steward-health`), and the decision page shows it with its age (stale after two
hours). A failed question submission is retried at the next hourly check; the queue tag `steward-health:<session>`
keeps a crash between `ask.ts` and the result write from asking twice.
