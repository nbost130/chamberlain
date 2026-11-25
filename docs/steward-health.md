# Steward health

The Steward is a long-lived thread that compacts when its context grows. Chamberlain checks context every minute and
publishes a health report hourly. It makes no model call. On a HAND OFF verdict it starts the hand-off itself, once
per session, as an ordinary wake
through the outbox; an adapter that cannot say how its Steward hands off (no `handoffInstruction`) falls back to
asking the operator once per session through the decision queue.

## What it reads

- The context guard uses the newest turn of the active provider thread. While a turn runs, the hourly report can cite
  the last exact reading on the same provider thread and its sample time. That older size cannot trigger compaction or
  resolve the outcome of a compaction. The Antigravity adapter can also read its native conversation database.
- T3's completed turn items supply thread rereads and completed compaction events. Self-transcript reads are available
  for Claude Code when its native session is identified. The optional native transcript still supplies history and format
  samples where available.

## Signals and verdicts

| Signal | Meaning | Default limit |
| --- | --- | --- |
| context | current tokens and, when reported, context window | watch at 100 000, compact above 130 000 |
| rereading | the Steward reads its own transcript, or re-reads the same thread within ten minutes | 3 self-reads, or 4 repeat thread reads |
| format (optional) | replies a prompt hook graded as slipped | 3 slips in the last 20 replies |

A self-read made for the hand-off itself, in the two turns after a compaction (recovering what the summary dropped), or to look a wake's own delivery id up for a repeat is the Steward doing what it was told, and does not count. An ordinary lookup of its own transcript does.

Quality counters reset at the latest recorded compaction on the active provider thread. A driver without a native
self-transcript signal reports it as not measured. This alone does not affect the verdict. Where self-transcript reads are not measured, repeat thread reads past the limit are
reported and make the verdict WATCH; they do not hand off, because the limit was set on the driver that measures both and an
ordinary Steward elsewhere passes it within hours. Verdicts:

- **OK**: nothing elevated and nothing unknown.
- **WATCH**: something elevated, or something could not be measured (unknown is never OK).
- **COMPACT**: current context above the compaction threshold without an elevated quality signal. The daemon
  sends `/compact` to the Steward's compaction webhook when the queue and adapter capability permit it.
- **HAND OFF**: a quality signal (rereading or format) is past its limit, or the last compaction did not bring the context back under the compaction line (`compact-ineffective`; the daemon records its compactions in state `steward-compact`, so a restart keeps the cooldown, and never compacts again instead of handing off). Compaction does not fix that. The daemon
  starts the hand-off itself, at most once per native session: it queues one wake (kind `handoff`, delivery id
  `steward-handoff:<session>`) telling the Steward to run its hand-off now, with no question to you. The wake is an
  ordinary outbox row sent by the one relay, so a failed delivery is retried with the usual pause and, after the
  attempts run out, dead-lettered with the `wake-dead-letter` alarm; retry or cancel it with `chamberlain wakes`. The delivery id
  is the record that this session was told, so a restart, a compaction or the next hourly check never queues a second.
  This needs the adapter's optional `handoffInstruction` capability (how a Steward on that backend starts its hand-off;
  the T3 adapter has it). An adapter without it leaves the hand-off to you: one `only-you` question through `chamberlain ask`,
  at most once per session, recommending the `/steward-handoff` command, and nothing starts automatically.

Health and compaction share `compactTokens` and the optional `contextGuard.compactShare`. When a window is
reported, the lower of the configured token limit and the window share applies. `contextGuard.watchTokens`
sets the watch line, capped at the effective compaction limit.

After `contextGuard.unknownTurns` consecutive completed turns without a measurement (default 3), one alarm is
raised. After `contextGuard.handoffTurns` such turns (default 60), the Steward uses the usual hand-off path. The
report identifies this as a turn-count fallback. Repeated polls of one turn do not advance the count. For a
provider with a native reader, only observed missing turns count because earlier projection rows cannot show
whether the native read succeeded. A provider refusal of `/compact` also leads to hand-off. On providers where
compaction is unverified, an accepted request with no completion or queue evidence after 30 minutes goes to
hand-off without a repeat request.

To guard other threads on the daemon's home backend, add entries to `guardedThreads` in [Configuration](CONFIGURATION.md).
An entry can alarm at the limit, or try compaction first and alarm when compaction is unavailable or fails.

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

Turn on `stewardTokens` to collect completed T3 turns hourly. Each row identifies the provider thread and the turn
ordinal, the delivery id when the run's input carries a verified wake envelope, the start and end times, the model
when recorded, and the source. The collector reads recent turns across provider switches, including one last read of a
retired Steward thread. Reads use bounded, read-only SQLite snapshots. Missing counters have no numeric value. A
projection with a changed schema reports that turn records are unavailable.

| T3 driver | Turn spend counters | Repeat thread reads | Own transcript / format hook | Context |
| --- | --- | --- | --- | --- |
| Claude Code (`claudeAgent`) | Reported when complete | Yes | Available with a native session and, for format, a configured hook | Projection |
| Codex (`codex`) | Reported when complete | Yes | Not measured | Projection |
| Cursor (`cursor`) | Reported when complete | Yes | Not measured | Projection |
| Antigravity (`antigravity`) | Reported when complete | Yes | Not measured | Projection or native request |
| Grok (`grok`) | Unavailable on the observed driver | Yes | Not measured | Projection if a size is published |
| Other drivers | Available if the projection supplies them | Yes, for recognizable tool items | Not measured | Projection if a size is published |

Claude Code and Antigravity have recorded successful explicit compactions. Other drivers may lack verification. A
recorded refusal overrides the driver's usual capability. When compaction is unsupported or an unverified request
ages out without running, the Steward hands off.

The projection's usage is the main-agent turn total. Chamberlain separates uncached input, cache read, cache write
and output for reporting and pricing. Reasoning tokens are a separate observation and are never added to output
again. Model request counts come from native transcript detail. Prices come from `overhead.prices` using each turn's
executed model. A requested model is not execution evidence. A missing model, missing price or incomplete turn
prevents a full-window spend figure. If only legacy transcripts lack a model, the report shows the priced subtotal
and counts the unpriced turns. Cost thresholds and fleet ratios require complete coverage.

`chamberlain steward-health tokens` reports the last 24 hours and 7 days, including per-kind token percentiles and
full-sweep statistics. Use `--json` for the underlying numbers. `chamberlain steward-health flow` reports turns and
tokens by source, digest flow and thread reads per digest item. Totals with incomplete token coverage are unavailable.

Claude Code transcripts remain available as an optional historical source through
`chamberlain steward-health tokens backfill`. Pass `--dir <folder>` or explicit transcript files if the current
adapter cannot locate a native transcript. Backfill groups canonical rows by turn-starting prompt, uses parent links
to assign overlapping requests, and deduplicates requests and tools by id. It supplies historical context trends and
per-request counts. Use `tokens --transcript` to inspect native detail on its own. The default report prefers the
projected row where native history covers the same turn. The two sources
never contribute separate counts for that turn.

New observations use the existing state table, with an additive time index for recent reports. The database
schema version is unchanged and earlier releases can still open it and read legacy transcript rows.

The daemon retains these turn records without automatic pruning. At 300 turns per day, that adds about 109,500
rows per 365-day year. Hourly refreshes replace rows for previously observed turns.
