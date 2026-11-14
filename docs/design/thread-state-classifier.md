# Thread-state classifier for idle parent threads (design)

Status: **implemented**, off by default (`provider: "none"`); `autoNudge` and `autoSettle` remain designed only. This document is the
design and the evaluation behind it; the settings as built are in [`../CONFIGURATION.md`](../CONFIGURATION.md#the-idle-thread-classifier).

## What it is for

The `idle-parents` check (on its own 15-minute timer) lists every top-level thread that finished its work and has sat idle
past a threshold. Today it calls no model: every idle thread whose last message changed is reported to the Steward, with
`looksLikeAsk` (a regular expression) used only to put likely asks first.

That is a net with no sorting. Most idle threads finished cleanly and need nothing; a few are waiting on a word, owe work they
never scheduled, or answered a question half-way. The regular expressions miss most of the second group. Two real misses
motivated this design:

- a thread whose last line was "say go and I'll start it", in a spoken closing line the ask rule did not read, which sat idle
  for nine hours;
- a thread that answered the operator's question half-way ("I haven't yet mapped those processes to tabs or extensions, so I
  can't say which ones account for it") and then sat all night.

The classifier asks a bank of narrow yes/no questions about each idle thread's last message, combines the answers in code
into one of four actions, and wakes the Steward only for the actions that need someone to act.

It is **optional**. With `provider: "none"` (the default) Chamberlain behaves exactly as it does without this feature and
makes no model call.

## Where it sits

```
engine-idle tick (every intervalMinutes)
  selectIdleThreads()                -> IdleThread records {server, threadId, title, idleMinutes,
                                        lastMessage, lastMessageHash, looksLikeAsk}
  classifyIdle(threads)              <- NEW: cache lookup by (server, threadId, lastMessageHash, bankVersion);
                                        classify only the misses, within budget; write thread_dispositions
  idleParentFindings(sel, dispositions)  <- CHANGED: drops ignore/settle in live mode, tags the rest
  recordEvaluation / wake            (unchanged: item system dedupe, holdable sweep wake)
```

The classifier consumes the plain records `selectIdleThreads` already returns and adds one field the selector can supply
from the same projection read: who wrote the message before the last one (`human`, `agent` or `none`). It does not read
threads itself.

Dedupe stays where it is. The item system keys a finding by `server:threadId:lastMessageHash` and is the only thing that
decides whether to notify. The disposition table below is a **classification cache**, not a second dedupe: it only answers
"have we already classified this exact message with this exact bank?".

## Actions

| Action | Meaning | What happens (live mode) |
|---|---|---|
| `escalate` | Someone has to decide or do something before work can continue. | Reported in the idle-parents wake, first, tagged `[ESCALATE]` with the questions that fired. |
| `nudge` | The thread itself owes work it has no way to resume. | Reported in the wake, tagged `[NUDGE]`. Optional `autoNudge` (off by default) posts a fixed continue message instead. |
| `settle` | Finished; nothing is owed. | Not reported. Listed in a once-a-day digest line. Optional `autoSettle` (off by default) settles the thread. |
| `ignore` | Legitimately waiting, or nothing matched. | Not reported. |
| `unknown` | Not classified (provider error, budget spent, redaction hook failed). | Reported exactly as today. A classifier failure never silences the net. |

## The question bank

One narrow question per **head**. Each is a yes/no with an explicit description of both outcomes, names the state field it
reads, and states the base rate where the answer is usually no. Wording below is the evaluated wording.

| id | Question (abridged) | Fires | Gate |
|---|---|---|---|
| `asks_decision` | Does `last_message` ask the reader (a human or a supervising agent) to decide, approve, confirm, review, merge or say go before work can continue? Most finished messages ask nothing. | escalate | |
| `needs_principal_task` | Does it ask the human to personally do something only a person can do (test on a device, sign in, change a permission, provide a secret, check their own screen)? | escalate | |
| `repeated_failure` | Does it say the same failure happened again after more than one attempt, or that the writer is stuck? | escalate | |
| `partial_answer` | Does it say part of what was asked is still unanswered, unchecked or not yet worked out? | nudge | only when `previous_message` is from a human |
| `promises_more_work` | Does it say the writer will itself do more work later, without first needing an answer? | nudge | unless `claims_armed_wait` and idle < `armedGraceMinutes` |
| `waiting_external` | Is the writer waiting on something outside the conversation (CI, a merge queue, a running job, another agent, a third party's review)? | nudge | unless `work_finished`; unless `claims_armed_wait` and idle < grace |
| `claims_armed_wait` | Does it say a watch, timer, scheduled job or background wait will wake the writer automatically? | modifier | |
| `work_finished` | Does it report the writer's assigned task finished, nothing more owed? | settle | |

The full wording, with the yes and no criteria, ships as the default bank file (`questions.default.json`).

**How answers combine.** Fixed precedence in code, `escalate > nudge > settle > ignore`:

1. any escalate question at or over its threshold: `escalate`;
2. `partial_answer`, when the previous message is from a human: `nudge`;
3. `promises_more_work`, or `waiting_external` without `work_finished`: `nudge`, unless `claims_armed_wait` and the thread
   has been idle less than `armedGraceMinutes` (default 360), then `ignore`. Every idle-parent candidate already has no
   running background task, so a thread that still claims an armed wait hours later has lost it;
4. `work_finished`: `settle`;
5. otherwise `ignore`.

Both gates in rules 2 and 3 use facts code already has, rather than asking the model a two-hop question. That is deliberate:
Jev reads literally and loses accuracy with each extra hop.

A user bank is a JSON array of `{id, ask, yes, no, fires: "escalate"|"nudge"|"settle"|"modifier", requires?, unless?, rules?}`.
`requires` takes structural facts (`human_asked`); `unless` takes other question ids; `rules` gives regular expressions for the
`rules` provider. Precedence stays fixed; a bank cannot invent a fifth action.

## Providers

| Provider | What it does | Leaves the machine |
|---|---|---|
| `none` (default) | No classification. Today's behaviour. | nothing |
| `rules` | Regular expressions per question (`looksLikeAsk`, `looksLikeStall`, and each question's `rules`). | nothing |
| `jev` | TypeSafe's Jev: one HTTP request per thread, one Noul head per question. | the redacted state below |
| `haiku` | The `claude` CLI, `--model haiku`, on the operator's own Claude Code login, one call per thread with every question. | the redacted state below |

Each provider is one function: `(state, bank) -> {answers: {id: probability}, model, inputTokens?, costUsd?, latencyMs}`.

Implementation notes the evaluation turned up:

- **Jev: call the HTTP API with `fetch`, not the 0.7.0 SDK.** Under Bun with concurrent requests the SDK threw
  `TypeError: Body already used` on nearly every call, though the requests reached the API and were billed. Plain `fetch`
  to `POST /v1/systemone` had no failures.
- **Pin the model** (`jev-1.14.0`) and record the response's `model` field; re-run the evaluation before moving the pin.
- **Cut tails on code points.** A `slice(-1500)` that splits an emoji leaves a lone surrogate, and Jev answers HTTP 400
  "Request contains invalid Unicode text". Use `.toWellFormed()` after the cut.
- **Validate every head**: present, a finite number in [0, 1]. A malformed answer is `unknown`, never an action.
- **Haiku through the CLI:** `claude -p --model haiku --setting-sources "" --tools "" --strict-mcp-config
  --disable-slash-commands --no-session-persistence --system-prompt <bank> --output-format json`, with `ANTHROPIC_API_KEY`
  removed from the environment so it runs on the operator's plan. Not `--bare`: bare mode requires an API key. About 1k
  tokens of overhead per call; parse the first JSON object in `result`.

## Configuration

Under `sweep.idleParents.classifier` in `config.json`. Unknown keys throw, as elsewhere.

```json
{
  "sweep": {
    "idleParents": {
      "classifier": {
        "provider": "jev",
        "mode": "shadow",
        "allowTextToLeaveMachine": true,
        "questions": "default",
        "thresholds": { "default": 0.5 },
        "send": { "lastChars": 1500, "previousChars": 400, "title": true },
        "redact": { "builtin": true, "command": null },
        "budget": { "maxPerRun": 20, "maxCallsPerDay": 500, "maxUsdPerDay": 0.25 },
        "armedGraceMinutes": 360,
        "autoNudge": false,
        "autoSettle": false,
        "jev": { "model": "jev-1.14.0", "keyFile": "typesafe.key", "timeoutMs": 10000 },
        "haiku": { "command": "claude", "model": "haiku", "timeoutMs": 60000 }
      }
    }
  }
}
```

- `provider`: `none` | `rules` | `jev` | `haiku`. Default `none`.
- `mode`: `shadow` (classify and record, report exactly as today) or `live` (report only escalate, nudge and unknown).
  A provider turned on starts in `shadow` unless `mode` says otherwise. This is the item system's existing shadow idea, applied
  to the classifier.
- `questions`: `default` or a path to a bank file.
- `thresholds`: `default` plus per-question overrides.
- `budget.maxPerRun`: the most classifications one tick makes. Threads past it stay `unknown` this tick (reported as today) and
  are classified on a later tick. `maxCallsPerDay` and `maxUsdPerDay` are summed from `thread_dispositions`; when either is
  spent, every unclassified thread is `unknown` until the next UTC day, with one log line.
- `jev.keyFile`: read from the config directory like the server token files, owner-only. Never the environment of the web
  process, never logged.

## Classify only when the message changes

The cache key is `(server, thread_id, message_hash, bank_version)`:

- `message_hash` is the selector's `lastMessageHash` (id and text of the last finished assistant message);
- `bank_version` is a hash of the bank, the thresholds, the provider and its model, and the send/redact settings. Changing any
  of them reclassifies on the next tick; nothing else does.

An idle thread is idle precisely because its last message is not changing, so at steady state a tick makes no calls.

## Schema

One new migration.

```sql
CREATE TABLE thread_dispositions (
	server TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	message_hash TEXT NOT NULL,
	bank_version TEXT NOT NULL,
	classified_at INTEGER NOT NULL,                       -- ms since epoch
	provider TEXT NOT NULL CHECK (provider IN ('rules', 'jev', 'haiku')),
	model TEXT,                                           -- the versioned id the provider reported
	mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
	action TEXT NOT NULL CHECK (action IN ('escalate', 'nudge', 'settle', 'ignore', 'unknown')),
	reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons)),   -- question ids that decided the action
	answers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(answers)),   -- {question id: probability}
	idle_minutes INTEGER NOT NULL,
	sent_chars INTEGER NOT NULL DEFAULT 0 CHECK (sent_chars >= 0),    -- characters that left the machine
	redactions INTEGER NOT NULL DEFAULT 0 CHECK (redactions >= 0),
	input_tokens INTEGER,
	cost_usd REAL,
	latency_ms INTEGER,
	error TEXT,                                           -- set when action = 'unknown'
	feedback TEXT CHECK (feedback IS NULL OR feedback IN ('right', 'wrong')),
	corrected_action TEXT CHECK (corrected_action IS NULL OR corrected_action IN ('escalate', 'nudge', 'settle', 'ignore')),
	PRIMARY KEY (server, thread_id, message_hash, bank_version),
	CHECK ((action = 'unknown') = (error IS NOT NULL))
);
CREATE INDEX thread_dispositions_by_time ON thread_dispositions (classified_at);
```

- No message text is stored. `answers` and `reasons` are enough to explain a decision; the text is in T3.
- `feedback` and `corrected_action` let the Steward (or the operator, from the decisions page) mark a disposition right or
  wrong. Those rows become the next evaluation set, which is the only honest way to tune thresholds.
- Retention: rows older than 30 days are deleted by the existing housekeeping, except rows with feedback.

## How escalations reach the Steward

Through the existing path, unchanged: the idle-parents item source returns findings, the item system dedupes them, and one
holdable `sweep` wake lists the new ones. In live mode the findings are only the escalate, nudge and unknown threads,
ordered escalate first, then nudge, then unknown, then by idle time. Each line carries the action, the questions that fired
with their probabilities, and the same excerpt as today:

```
[ESCALATE asks_decision 0.98] thread "…" on <server> (threadId …), idle 540 min. Last message: …say go and I'll start it.
[NUDGE partial_answer 0.97] thread "…" on <server> (threadId …), idle 566 min. Last message: …so I can't say which ones account for it.
```

`settle` threads go into one digest line a day ("12 idle threads look finished: …"). `autoNudge` and `autoSettle` act on a
thread without the Steward and are therefore off by default and separate switches.

## Privacy

- **Off by default.** `provider: "none"` sends nothing anywhere. `rules` sends nothing anywhere.
- **Opt-in twice for text leaving the machine.** `jev` and `haiku` are refused at config load unless
  `allowTextToLeaveMachine` is `true`.
- **What leaves, exactly:** the thread title (unless `send.title` is false), the last `lastChars` characters of the last
  assistant message, and the last `previousChars` characters of the message before it, labelled only `human`, `agent` or
  `none`; all after redaction. Never thread ids, server names, file contents, tool output or the rest of the transcript.
  The question bank goes with it.
- **Where it goes:** `jev` to TypeSafe's API (TypeSafe states it does not train on requests; zero retention is offered only on
  enterprise plans, so assume retention). `haiku` to Anthropic through the operator's own Claude Code login, under that plan's
  terms.
- **Redaction hook.** Built-in rules replace emails, common API-key and token shapes, JWTs, phone numbers and home-directory
  user names. `redact.command`, if set, is run with the state as JSON on stdin and must print the state as JSON on stdout
  within 5 seconds. If it fails, times out or prints something else, nothing is sent and the thread is `unknown` (reported as
  today). Every disposition records `sent_chars` and `redactions`, so what left is auditable.

## Evaluation

Read only. Live database and thread projections were read; nothing was written to T3 or the database.

### Data

- Population: 528 top-level threads across three servers that are idle-parent candidates (top level, not archived, idle or
  completed, no open card). 513 had been idle over 30 minutes; only 5 were still unsettled, because operators settle threads
  quickly. Settled threads were kept: their last message is the message the check would have seen when they went idle.
- Sample of 48 last messages: the 2 known misses (recovered from the threads' history), the 5 unsettled threads, 18 random
  from the 286 whose last message was from the last two weeks, and 23 chosen by a keyword filter for asks, waits and promises,
  to get enough positives. The keyword-enriched part makes positives more common than in the population, so precision here
  is higher than it would be live.
- Labels: one labeller (the author), written before any classifier was run, from the last message, the message before it and
  the idle time. Distribution: escalate 17, nudge 8, settle 23, ignore 0. Six rows are marked hard (status reports that list
  recommended approvals; a handback that says "merge when you want"; a message pointing at a question in another thread).
- No row had a genuine repeated failure, so `repeated_failure` recall could not be measured.

### Per question, threshold 0.5 (precision / recall; false positives)

| question (positives) | Jev, one request | Jev, one request per question | Haiku | rules |
|---|---|---|---|---|
| asks_decision (16) | 0.65 / 0.81 (7) | 0.63 / 0.75 (7) | 0.71 / 0.63 (4) | 1.00 / 0.38 (0) |
| promises_more_work (5) | 0.83 / 1.00 (1) | 0.71 / 1.00 (2) | 1.00 / 0.60 (0) | 1.00 / 0.20 (0) |
| work_finished (32) | 0.96 / 0.81 (1) | 1.00 / 0.81 (0) | 0.81 / 0.94 (7) | 0.85 / 0.69 (4) |
| waiting_external (8) | 0.47 / 1.00 (9) | 0.47 / 1.00 (9) | 0.73 / 1.00 (3) | 0.38 / 0.75 (10) |
| claims_armed_wait (3) | 0.75 / 1.00 (1) | 0.75 / 1.00 (1) | 1.00 / 1.00 (0) | 0.50 / 1.00 (3) |
| repeated_failure (0) | n/a (1) | n/a (1) | n/a (0) | n/a (2) |
| partial_answer (1) | 0.03 / 1.00 (31) | 0.03 / 1.00 (30) | 0.17 / 1.00 (5) | n/a / 0.00 (0) |
| needs_principal_task (3) | 0.60 / 1.00 (2) | 0.60 / 1.00 (2) | 0.67 / 0.67 (1) | 1.00 / 0.67 (0) |

The `rules` column is the shipped `looksLikeAsk` and `looksLikeStall` plus plain regular expressions written after reading the
sample, so it is optimistic.

`partial_answer` asked with no gate fires on nearly every Jev row (its highest true negative was 0.96): a message from an
agent that was told to do a task almost always leaves something "not yet done". That is why the combine step only counts it
after a human's message.

### Actions

With the combine rules above (the human-asked gate and the finished-task gate on `waiting_external`):

| provider | action accuracy | escalate P / R | nudge P / R | settle P / R | "say go" miss | half-answer miss |
|---|---|---|---|---|---|---|
| Jev, one request | 31/48 (65%) | 0.64 / 0.82 (14 of 17 caught, 8 false) | 0.67 / 1.00 | 0.82 / 0.39 | escalate | nudge |
| Jev, one request per question | 30/48 (63%) | 0.62 / 0.76 | 0.67 / 1.00 | 0.75 / 0.39 | escalate | nudge |
| Haiku | 34/48 (71%) | 0.69 / 0.65 (11 of 17 caught, 5 false) | 1.00 / 0.63 | 0.67 / 0.78 | escalate | nudge |
| rules | 32/48 (67%) | 1.00 / 0.41 (7 of 17 caught, 0 false) | 0.40 / 0.75 | 0.73 / 0.83 | escalate | settle |

Without the two gates (the bank asked as written, combined naively) Jev's accuracy was 60% and Haiku's 77%: the gates were
added after seeing these results, so the gated numbers are development-set numbers, not a held-out measurement.

Escalate recall is the number that matters most: a missed escalation is a thread sitting for hours, which is the failure this
feature exists for; a false escalation is one extra line in a wake. With 17 escalations, the 95% intervals are wide: Jev
recall 0.59 to 0.94, Haiku 0.41 to 0.83, Jev precision 0.43 to 0.80. The Jev-Haiku difference is not significant at this size.

Four of Jev's eight false escalations are hard rows where both Jev and Haiku said escalate and the label said settle (status
reports listing approvals the operator should give). Whether those should wake the Steward is a policy choice, not a model
error.

### Cost, latency, stability

| | input tokens per thread | cost per thread | median latency | p90 |
|---|---|---|---|---|
| Jev, all 8 heads in one request | 1,717 | $0.000072 | 104 ms | 164 ms |
| Jev, one request per question | 6,279 | $0.000264 | 93 ms per request | 170 ms |
| Haiku via CLI | ~1k overhead + state | $0.00059 notional (plan, not billed per token) | 9.7 s | |

Jev price: $0.042 per million input tokens, output free (TypeSafe models page, Jev 1.14). Context limits: 64k tokens per
request, 32k for state plus any one question; a thread here uses under 2k.

- **One request with every question is the right shape.** Asking each question in its own request gave the same answers
  (mean difference 0.012, 4 of 384 answers crossing 0.5) at 3.7 times the tokens, because the state is billed once per request.
  This is still one narrow question per head; the questions do not see each other.
- **Run to run**, two identical Jev runs differed by a mean of 0.013 (max 0.11); 4 of 384 answers crossed 0.5. Leave a margin
  around any threshold.
- **Per day, 20 idle threads:** with the hash cache a thread is classified once per new last message. At three new idle
  messages per thread per day that is 60 classifications, about 103k tokens, **about $0.004 a day**. The worst case, every
  thread classified on every one of 96 ticks with no cache, is 1,920 classifications, about **$0.14 a day**.

### Recommendation

- **Provider: `jev`**, with every question as one head in a single request per thread, behind the combine rules above. On this
  set it caught 14 of 17 escalations (recall 0.82, precision 0.64) and both known misses, at about a tenth of a second and a
  fraction of a cent a day. Haiku is a reasonable alternative for operators without a TypeSafe key (more precise, less recall,
  100 times slower); `rules` stays the zero-dependency choice and catches under half the escalations.
- **Ship it in `shadow` mode first** and collect Steward feedback on dispositions until there are at least 100 fresh labelled
  rows. Re-measure on those before `live`; the numbers above come from one labeller on a set the combine rules were adjusted
  against.
- **Thresholds stay at 0.5** until that fresh set exists. On this set `needs_principal_task` at 0.65 and `promises_more_work`
  at 0.65 would have removed false positives, but tuning on 48 rows and then quoting those 48 rows is the reused-holdout trap.
- **Rewrite `partial_answer`** before live: even gated, it is the noisiest head. A narrower wording ("does `last_message` say
  the writer has not yet checked or found something it needs to answer the question in `previous_message`?") is the first
  candidate, measured on fresh rows.

## Not in scope

- Reading more of the thread than the last two messages.
- Classifying child threads or threads with an open card (they are not idle parents).
- Any automatic action by default. `autoNudge` and `autoSettle` are designed but off.
