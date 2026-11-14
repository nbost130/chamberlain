# Email triage: clean up, dig deeper, or ask

Design only. Nothing here is built. Written 2026-11-14 for issue #30, where Nathan asked for an **optional** module that triages his
mail: clean up what needs no attention, dig into what does, ask him about the rest, and pull the interesting items out of newsletters
he never gets to. It must be generic enough for another operator and hold none of his secrets. Every guarantee below names the code that
enforces it; a guarantee that only a prompt keeps is not claimed. Commands quoted for `gog` were read from `gog --help` (v0.47.1)
on 2026-11-14; no mailbox was read or changed to write this.

## 1. The shape in one table

| Stage | Who decides | Cost | Can change the mailbox |
| --- | --- | --- | --- |
| Fetch headers | code, through the provider (`gog`) | no model | no |
| Header and sender rules | code: triage rules in force, built-in header facts | no model | yes, only a rule Nathan confirmed, only in `live` mode |
| Driver | Haiku, no tools, reads headers and sanitized text | small, bounded per run | no: it only labels |
| Escalation | Sonnet, then Opus, on stated triggers only | bounded per run, Opus off by default | no: it only labels |
| Outcome | code maps the label to one of three outcomes | none | auto-clean only through a rule or Nathan's tap |
| Cards | the decision queue, through the same core function `ask.ts` uses | none | the answer, carried out by code |
| Report | a file plus one line; the Steward is woken only when something needs it | none | no |

## 2. How a module plugs in

**Decision: a module is a folder `src/modules/<name>/` that core never imports, with one config section that is off by default, its own
database file, and one registry the entry points read.** The reason: the classifier (#14) proved the config half of this pattern
(`sweep.idleParents.classifier`, `provider: "none"` by default, unknown keys throw, text leaves the machine only with two switches), and
`src/architecture.test.ts` already proves the import half for adapters. A module combines the two.

| Piece | Rule | Enforced by |
| --- | --- | --- |
| Code | `src/modules/mail/`. It imports `src/core/` and itself, never an adapter and never another module. Only `src/modules/index.ts` (the registry) names more than one module. | Three new cases in `src/architecture.test.ts`: `core/` must not import `modules/`, a module must not import `adapters/` or another module, and only `cli.ts`, `daemon.ts` and the registry may import `modules/index.ts`. |
| Config | Section `mail` in `config.json`. Absent, or `"provider": "none"`, is off. Parsed by `parseMail()` in the classifier's style: defaults for what is left out, unknown keys throw at load, a provider that sends mail text to a model is refused unless `allowMailToLeaveMachine: true`. | `src/modules/mail/config.test.ts`, as `classifier/config.test.ts` does. |
| State | Its own `mail.db` beside `chamberlain.db`, WAL, mode 0600, with its own migrations. Created on the first run with the module on, never before. | A test that a daemon start and a `chamberlain mail` command with the module off create no file. |
| Off means absent | The registry returns no module: no timer, no tables, no wake kind, no page change. `chamberlain mail …` prints "mail triage is off (config.json `mail.provider`)" and exits 0. | A daemon test with `mail` absent asserting no `mail.*` event, no child process and no `mail.db`. |
| Deleting it | Remove the section and `mail.db`. Nothing in `chamberlain.db` refers to it but the cards it filed, which are ordinary resolved items. | |

Why a separate `mail.db` and not migrations in `chamberlain.db`: database migrations are one numbered sequence, so a module's tables there
would be created for every operator, on or off, and an older daemon would refuse the database over a mail change (#12's deploy-order
problem, which `obs.db` avoids the same way). The one place the module touches `chamberlain.db` is the decision queue, through core
functions, and that link is reconciled by key (section 5), never by a shared transaction.

Model calls go through one shared runner, factored out of `src/core/classifier/providers.ts` into `src/core/llm/cli.ts` (B1): the same
`claude -p` argv the classifier uses, with the model as a parameter. The classifier and the module then hold one copy of the no-tools rule.

```json
"mail": {
  "provider": "gog",
  "mode": "shadow",
  "allowMailToLeaveMachine": true,
  "gog": { "command": "gog", "account": "me@example.com", "timeoutMs": 60000 },
  "scope": { "query": "in:inbox", "lookbackDays": 7, "maxMessagesPerRun": 200 },
  "schedule": { "times": ["07:30", "16:30"], "days": "mon-fri", "tz": "America/New_York", "maxRunsPerDay": 4 },
  "labels": { "prefix": "Chamberlain" },
  "models": { "command": "claude", "driver": "haiku", "escalate": "sonnet", "top": "opus" },
  "budget": { "driverCallsPerRun": 10, "escalateCallsPerRun": 8, "topCallsPerRun": 0, "inputTokensPerDay": 600000 },
  "important": { "senders": ["@school.example"], "words": ["invoice", "due", "contract", "tax", "court", "overdue"] },
  "newsletters": [ { "name": "Unsupervised Learning", "match": { "listId": "<the newsletter's List-Id>" }, "maxHighlights": 5 } ],
  "interests": ["AI security", "agents", "personal knowledge tools"],
  "save": { "file": "~/notes/Reading list.md" }
}
```

`mode` follows the roadmap's rule that authority features ship in audit: `shadow` (the default) runs everything, files the cards, and
changes nothing in the mailbox, recording what each rule *would* have done; `live` lets confirmed rules and tapped cards act.

## 3. The mail provider

**Decision: a provider is a small typed interface with five verbs, and it has no method that sends, deletes or trashes.** The provider
uses the mail tool's own authentication; Chamberlain stores no mail credential and never sees one.

```ts
interface MailProvider {
  readonly id: string;                                            // "gog", "command"
  readonly can: { labels: boolean; history: boolean; categories: boolean };
  list(q: { query: string; max: number; cursor?: string }): Promise<{ refs: MailRef[]; cursor: string; complete: boolean }>;
  read(id: string, o: { as: "headers" | "triage" | "thread" | "newsletter"; maxChars: number }): Promise<MailRead>;
  archive(ids: string[]): Promise<ActResult>;                     // out of the inbox; still in All Mail
  label(ids: string[], o: { add: LabelName[]; remove: LabelName[] }): Promise<ActResult>;
  markRead(ids: string[]): Promise<ActResult>;
}
type LabelName = `${string}/${string}` | "INBOX" | "UNREAD";     // checked at runtime, below
```

`list` returns a partial page as an error, never as a shorter list (the roadmap's rule: an error never reads as clear). `read` as
`headers` returns `From`, `To`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted` and the provider's
category, and the message's labels and read state as they are now (kept for undo, section 8); as `triage`, those plus at most `maxChars` of text with links and HTML removed; as `thread`, the same for every message of its thread; as `newsletter`, the text with every link
replaced by `[L1]`, `[L2]`… and the links returned beside it in a table only code reads (section 6).

**gog (first provider).** Each verb is one `gog gmail` command with `--json --no-input --gmail-no-send` and `-a <account>`, and an
exact command allowlist (`--enable-commands-exact`) naming only these:

| Verb | gog command (v0.47.1) |
| --- | --- |
| `list` | `gmail messages search <query> --max N --page <token>`; later runs use `gmail history --since <historyId>` |
| `read` headers | `gmail get <id> --format=metadata --headers=From,To,Subject,Date,List-Id,List-Unsubscribe,Precedence,Auto-Submitted` |
| `read` triage | `gmail get <id> --format=full --sanitize-content` ("strip HTML, remove HTTP(S) URLs") |
| `read` thread | `gmail thread get <threadId> --full --sanitize-content` |
| `read` newsletter | `gmail get <id> --format=full`; links are extracted and replaced in code |
| `archive` | `gmail archive <id>…` |
| `label` | `gmail batch modify <id>… --add-label <l> --remove-label <l>`; `gmail labels list` and `gmail labels create` for the prefix; undo restores `INBOX` and `UNREAD` the same way |
| `markRead` | `gmail mark-read <id>…` |

Never in the allowlist: `send`, `reply`, `reply-all`, `forward`, `autoreply`, `drafts`, `import`, `track`, `trash`, `batch delete`,
`labels delete`, `settings`, `attachment`, `url`. The read verbs also run with `--readonly`, which gog describes as "Block mutating API
requests at runtime". The gog child gets an environment built from an allowlist (`HOME`, `PATH`, `LANG`, `TMPDIR`, plus any names the operator lists in `gog.env`, such as the keyring's variables); `GOG_ACCESS_TOKEN` is never passed, so gog uses its own stored login. Its stderr is discarded and its errors are reduced to fixed phrases, as the classifier's providers do, so nothing it prints is logged. The exact dot-path spelling `--enable-commands-exact` takes is pinned by B2's test against the real binary.

**Other providers.** `"provider": "command"` runs an operator's own command that speaks the same five verbs as JSON on stdin and stdout
(the roadmap's plugin rule: commands, not dynamic imports), so another mail system needs no change to Chamberlain:

| System | Archive | Label | Mark read | Auth stays with |
| --- | --- | --- | --- | --- |
| IMAP (for example through `himalaya`) | `MOVE` to the Archive folder ([RFC 6851](https://www.rfc-editor.org/rfc/rfc6851)) | a keyword flag ([RFC 9051 §2.3.2](https://www.rfc-editor.org/rfc/rfc9051#section-2.3.2)) | `\Seen` | the client's own config or keyring |
| Outlook, Microsoft 365 | move to the Archive folder (Graph `message: move`) | categories | `isRead` | a CLI holding its own token |

A provider without labels (`can.labels: false`) still archives and marks read; label actions fall back to "keep" and say so in the report.

## 4. The pipeline, cheapest first

**Decision: code decides every message it can, Haiku drives the rest, and a higher tier runs only on a named trigger.** This is
Chamberlain's own rule (R98: code first, then a cheaper model, a higher tier only where judgement is needed), and in the research
literature it is an *LLM cascade* ([FrugalGPT, Chen, Zaharia and Zou, 2023](https://arxiv.org/abs/2305.05176)).

1. **Fetch.** New messages since the last cursor, at most `maxMessagesPerRun`, headers only. A message already triaged (by provider id)
   is skipped.
2. **Rules (code, no model).** In order, first match wins:
   - an `important` sender, or an `important` word in the subject, is flagged first. A flagged message is acted on by a triage rule only
     when the rule's match is that exact from-address; a broader rule (domain, `List-Id`, category, subject prefix) skips it. Otherwise it
     goes to the driver flagged, and it is never cleaned without a tap (step 4);
   - a triage rule in force (section 5) whose match fits: its action;
   - a configured newsletter: the newsletter stage (section 6);
   - everything else goes to the driver, with the header facts attached: list mail (`List-Id`, [RFC 2919](https://www.rfc-editor.org/rfc/rfc2919);
     `List-Unsubscribe`, [RFC 2369](https://www.rfc-editor.org/rfc/rfc2369)), bulk (`Precedence: bulk`), machine-sent (`Auto-Submitted`,
     [RFC 3834](https://www.rfc-editor.org/rfc/rfc3834)) and the provider's category.
3. **Driver (Haiku).** Up to 10 messages per call: headers, facts and at most 1,500 characters of sanitized text each. It answers, per
   message slot, `{label: clean | newsletter | deeper | ask | keep, confidence, why (at most 200 characters), facts: {due?, amount?, waitingOn?}}`.
4. **Escalation (Sonnet), only when** the driver said `deeper` (at any confidence: digging deeper *is* the escalation); or `ask` with
   confidence under 0.7; or a flagged message was labelled `clean` (a disagreement with code is never settled by the cheaper model, and a
   flagged message goes to an ask card whatever Sonnet says); or the driver's answer for a slot failed validation twice. With the escalation
   budget spent, a `deeper` message becomes an ask card carrying the driver's `why` and a note that it was not read in full. Sonnet reads
   the whole thread (`read(as: "thread")`), sanitized, up to 12,000 characters, and answers in the same shape plus a summary of at most 400 characters.
5. **Top tier (Opus), only when** Sonnet says `ask` with confidence under 0.6 about an `important` sender. Off by default
   (`topCallsPerRun: 0`); at most one call a run when on.
6. **Outcome (code).** `clean` → the cleanup batch (never an action on its own; section 9 asks about that); `deeper` → Sonnet's summary becomes an ask card or a note in the report;
   `ask` → an ask card; `newsletter` from an unknown sender → a one-tap "Digest this sender?" card; `keep` → left alone.

**Budgets.** Every limit is an acceptance test. The driver and escalation calls go through the `claude` CLI on the operator's own
subscription login. There is **no pay-per-token lane**: the runner passes the CLI an environment built from an allowlist (`HOME`, `PATH`,
`LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`), so `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` never reach it, and `--setting-sources ""` keeps an `apiKeyHelper` out.

| Per run (estimates until B9 measures them) | Calls | Input tokens | Output tokens |
| --- | --- | --- | --- |
| Driver, 10 messages a call (about 1k CLI overhead, about 900 per message) | at most 10 | about 100k | about 15k |
| Escalation, one thread a call | at most 8 | about 36k | about 4k |
| Newsletters, one issue a call | at most 3 | about 21k | about 5k |
| Top tier | 0 (1 when on) | 0 (about 15k) | 0 (about 1k) |
| **Ceiling** | **21** (22 with Opus on) | **about 157k** (172k) | **about 24k** (25k) |
| Typical: 50 new messages, 60% settled by rules, one newsletter | 3 | about 30k | about 5k |

The ceiling is under a third of one Steward wake (about 540k tokens, mostly cache reads, per OBSERVABILITY.md section 8). Per day the
module stops at `inputTokensPerDay` (600k, so at most about four full runs) and `maxRunsPerDay`. A run that reaches a cap stops calling
models, files what it has, leaves the rest for the next run and says so in its report. Once `plan_usage` exists (OBSERVABILITY.md, B4; designed, not built), a
run starts in **rules-only** mode, with no model call at all, whenever the five-hour window is at or above 80% or the weekly window at or
above 90%. Each call writes one `mail.attempt` event (model, input and output tokens, latency; through OBSERVABILITY.md's registry once its B1 lands, and
until then through today's `log.ts` with numbers only), because these calls run with
`--no-session-persistence` and so no transcript reader sees them; this is the lesson of the classifier's `classifier.attempt`.

## 5. Three outcomes, mapped onto what Chamberlain has

**Decision: every card is an ordinary decision-queue question, filed through the same core function `ask.ts` uses, with tag `mail`; an
answer to a mail card is carried out by the module's code and wakes the Steward only when Nathan writes a note.**

| Outcome | What Nathan sees | Kind, urgency | Options (recommended first) |
| --- | --- | --- | --- |
| **Auto-clean, by rule** | nothing; counted in the report | none | - |
| **Auto-clean, by model** (the cleanup batch) | one card per run: "18 messages look like cleanup", grouped by sender, each line sender and subject | `only-you`, `urgent: false` | Archive all; Archive all but the ones I note; Leave them |
| **Dig deeper** | the summary and facts (due date, amount, who waits) on an ask card, or a line in the report when nothing is owed | as below | as below |
| **Ask Nathan** | sender, subject, the summary, the facts, the model's recommendation and why | `only-you`; urgent only for an `important` sender or a due date within 48 hours | Keep in inbox (I'll handle it); Archive; Label Follow-up; plus "Always archive mail like this" when a rule could express it |
| **Newsletter digest** | section 6 | `idea`, `urgent: false` | Save all; Skip this issue; Fewer like this |
| **Triage rule proposal** | the rule in words, its match, its action, and its backtest | `ruling`, `urgent: false` | Confirm; Not now; No |

How it uses the existing pieces:

- **One queue, one page.** Cards use the `Question` shape `ask.ts` checks (`parseAsk`), so they rank, render and post exactly as the
  Steward's questions do. The module calls the core function (`askQuestion`, plus the post that `ask.ts` does for an urgent question, moved
  into core as `fileQuestion` in B5), not the CLI, because the CLI's settled check matches on title overlap: two issues of one
  newsletter would look settled. A mail card's identity is its message id, kept in `mail.db` (`mail_cards`), and the module never files
  a second card for a message it already asked about.
- **No Steward wake per tap.** Today an answer goes to the Steward unless its option has `route: "thread"`. B5 adds `route: "record"`:
  the claim is written as now, and no wake row is queued. The module reads answered mail cards by item id on every run and on a one-minute
  timer, carries out the choice (archive, label, save), and records the item id as done in `mail.db`, so a crash repeats an archive, which
  is harmless, and never skips one. The existing rule stands: an answer with a note always reaches the Steward as an answer wake.
  Record-only claims need two more changes in B5, because today's claim recovery (`recoverClaims` in `src/core/questions.ts`) re-sends any
  unresolved claim whose wake is not delivered, and the page owns every page claim: recovery skips a record-only claim (it has no wake to
  send), and the claim is resolved when the module records the item done, in `chamberlain.db`, keyed by item id. A test restarts the daemon
  between the claim and the module's action and asserts the action happens once and no wake is sent.
- **Rulings stay the Steward's.** A triage rule is not written to `rulings`, because every wake repeats the rulings in force, and dozens of
  sender rules would ride in every wake for nothing. Triage rules live in `mail.db` (`mail_rules`) with the ruling lifecycle and its
  words: `proposed`, `in-force`, `retired`; recording is idempotent on the normalized match and action; `supersedes` and `expires` work as
  for rulings.

**How a rule is learned, and why it cannot act before Nathan confirms it.**

1. *Proposed by code, not by a model.* When Nathan has chosen the same cleanup for the same sender key (from-address, from-domain or
   `List-Id`) three times in 30 days, or ticked "Always archive mail like this", the module writes a `proposed` rule. A rule's match is a
   closed set of fields (from-address, from-domain, `List-Id`, has `List-Unsubscribe`, provider category, subject prefix as a literal),
   never a model-written pattern, and its action is one of `archive`, `label:<prefix>/<name>`, `mark-read`, `newsletter`, `ask`, `keep`.
2. *Backtested on metadata.* The proposal card states what the rule would have matched in the last 30 days of kept metadata ("14
   messages; 3 shown") so Nathan confirms a rule by its effect, not its wording.
3. *Confirmed only by a card answer.* The only writer that moves a rule to `in-force` is the answer handler, reading a claim on that rule's
   own proposal item with the Confirm option. There is no CLI for it, so the Steward cannot confirm one either. A test asserts that no other
   code path updates `mail_rules.status` to `in-force`.
4. *Retired the same way, or by `chamberlain mail rules retire <id>`.* Retiring is safe in either direction, so the Steward may do it.

## 6. Newsletter digests: Unsupervised Learning as the worked example

**Decision: one card per issue, at most five highlights, picked by code from what the model extracts, with links taken from the mail
by code and never written by the model.** The word *digest* already means a composed wake (GLOSSARY.md), so the feature is the
**newsletter digest** and its tables and config say `newsletter`, never `digest`.

1. *Match.* A configured newsletter's sender or `List-Id` matches. (Example: the weekly Unsupervised Learning issue.)
2. *Read.* `read(as: "newsletter")`: the text, at most 30,000 characters, with each link replaced by `[L1]`…`[Ln]`. The link table stays
   in the run's memory; the model never sees a URL.
3. *Extract (Haiku, one call).* Up to 25 candidate items: `{title (≤90 chars), gist (≤200 chars), link: "L7" | null, topics: [≤3 words]}`.
   A link reference that is not in the table is dropped. A candidate with no link is kept, linked to the issue itself.
4. *Pick (code).* Each candidate scores by overlap of its topics with `interests`, plus what Nathan saved from this newsletter before
   (topics of saved highlights up, of skipped issues down, from `mail_highlights`). The top `maxHighlights` go on the card.
5. *Card.* Title "Unsupervised Learning: 5 picks from <issue date>"; context is one bullet per highlight, `- <title>: <gist>`; options
   Save all (recommended), Skip this issue, Fewer like this. "Fewer like this" lowers the issue's topics in the profile; it changes no rule.
6. *Save.* "Save all" appends to `save.file`, a Markdown file in Nathan's notes: one heading per issue with each highlight as
   `- [title](url): gist (Unsupervised Learning, <date>)`. Instead of a file, `save.command` names a command that receives the same lines
   as JSON on stdin (for Readwise Reader or a to-do app). The newsletter mail is then archived and labelled `<prefix>/Digested`.

The link saved is the one in the mail, which may be a tracking redirect. Code unwraps a redirect only when the target sits in its own query
string (such as `?url=`), without fetching anything; otherwise the link is saved as it is. With `save.file` it is followed only when
Nathan opens it. A `save.command` is the operator's own program and may fetch what it is given (Readwise Reader does): it runs only on
Nathan's "Save" tap, it is outside the module's no-fetch guarantee (section 8), and the config docs say so beside the key.

## 7. Scheduling, and reporting without filling the Steward's context

**Decision: the daemon runs triage on the configured schedule as a separate process; the Steward decides by running it, pausing it or
changing the schedule; a normal run wakes nobody.**

- **Who starts a run.** The daemon's timer starts `chamberlain mail run` at each `schedule.times` entry, as a child process with
  `nice 19`, a 10-minute deadline and a `flock` on `mail.lock` in the state directory, so a run that hangs never blocks the relay and two
  never overlap. The Steward decides the rest: `chamberlain mail run --now` (refused while one runs), `mail pause --until <ISO>`,
  `mail resume`. Pause and an ad hoc run are state rows in `mail.db`; the schedule itself is config, which the Steward may edit in
  `config.json` as it does other keys.
- **What a run leaves.** One report file, `reports/mail/<run-id>.md` in the state directory (mode 0600, kept 30 days), with counts per
  stage and outcome, card ids, rule ids, tokens per tier and any cap reached: never a subject, sender or summary, which live only on the
  cards. One `mail.run` event with the same counts.
- **How the Steward hears.** A run wakes the Steward only when it needs the Steward: it failed (the provider erred or a partial list came
  back), hit a cap two runs in a row, or the Steward asked with `mail run --now --notify`. Those go as one wake of kind `mail`, at most three
  lines composed by code, holdable and folded like any other:

  ```
  Mail run m-7f3c (scheduled 16:30): 64 seen, 41 by rule, 18 to the cleanup card Q-ab12cd, 2 asks (Q-…, Q-…), 1 newsletter card.
  37k input tokens, rules-only: no. Driver cap reached: 12 messages left for the next run.
  Report: ~/.local/state/chamberlain/reports/mail/m-7f3c.md
  ```

  A run with nothing wrong adds one line to the next full sweep's text (`mail: 2 runs, 6 cards open, report <path>`) and nothing else.
  Nathan's cards reach him through the queue, not through the Steward.

## 8. Safety, and the code that holds each guarantee

Mail is untrusted input written by anyone. The design follows the **dual LLM pattern**
([Simon Willison, 2023](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)): the model that reads untrusted text has no tools and
cannot cause an action, and the code that acts reads only that model's answer fields, validated. What the pattern does **not** give, and
this design does not claim: a mail can still steer the model's *valid* answer (label a phishing message `clean`, or write an instruction
into its summary). The design limits what such an answer can do: a model label alone never changes the mailbox (it only fills the cleanup
card Nathan taps), a flagged message is never cleaned by a model label, and model text reaches only card text and the save target, as
plain text.

| Guarantee | How it is enforced (not by a prompt) | Test |
| --- | --- | --- |
| The reading model cannot act | Every call is `claude -p --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence --system-prompt <fixed> --output-format json`, mail on stdin, never in argv. The argv is built in one function. | Snapshot test of the argv; a test that the runner refuses any argv missing `--tools ""`. |
| Instructions in mail gain no authority | The reply is parsed against a closed schema: `label` an enum, `confidence` in [0, 1], `why` and `summary` length-capped, `facts` typed, slots matched to the message ids code sent. Anything else makes that message `ask`, with headers only. The model chooses no message id, label name, folder, recipient or URL; a `clean` label only adds the message to the cleanup card; card text is rendered as text, with any URL in it shown unlinked. | Fuzz test: malformed replies (extra fields, wrong slots, long text, tool-call shapes) become `ask`. Injection test: *valid* replies a hostile mail could produce (`clean` for a flagged message, a summary holding an instruction or a URL, a link reference not in the table) are run through every consumer (outcome mapping, cards, page, save file, rule proposal) and change nothing but card text. |
| Never sends, replies or forwards | `MailProvider` has no such method; gog runs with `--gmail-no-send` and an exact allowlist that names no send command. Two layers, either enough. | B2 runs the real `gog` with the module's flags and an empty `--home` (no credentials, so nothing can reach a mailbox), and asserts that `send`, `reply`, `forward` and `drafts` fail with gog's command-policy refusal (its own message, matched exactly), while an allowed command with the same flags gets past the policy and fails only at authentication. The control proves the refusal is the allowlist, not a missing login. |
| Never deletes | No delete or trash method; `trash`, `batch delete` and `labels delete` are outside gog's allowlist; `label()` refuses `TRASH`, `SPAM` and every other system label, except removing `INBOX` or `UNREAD` and, for undo only, adding them back; added labels must otherwise start with `labels.prefix/`. | Unit tests on `label()`; B2's refusal test includes `trash` and `batch delete`. |
| Cleanup is reversible | Archive keeps the message in All Mail; every module action also adds `<prefix>/Triaged`. Before acting, the module records each message's inbox and read state and the labels it will add (`mail_actions`, 90 days). `chamberlain mail undo <run-id>` restores exactly that: `INBOX` and `UNREAD` back where they were, its own added labels removed. It never removes a label it did not add. | Round-trip test against the fake provider comparing the full label set and read state before the action and after undo. |
| Tracking links are never opened by the module | The module has no HTTP client: an architecture test fails if any file under `src/modules/mail/` calls `fetch(`, imports `node:http`, `node:https`, `node:net` or `undici`, or spawns anything but the provider, the model CLI and the configured `save.command` (the operator's own program, run only on a Save tap; section 6). Triage text comes from `--sanitize-content` (URLs removed); newsletter links are swapped for references before the model sees them. No mail HTML is rendered anywhere, so no tracking pixel loads; the page's CSP is already `img-src 'self'`. | The architecture test; a test that model input contains no `http` substring. |
| Only metadata and bounded derived text are kept | Mail-derived text is written to exactly three places: `mail.db`'s capped columns (`CHECK(length(...) <= n)`), the card's question in `chamberlain.db`, and the save target on a Save tap. Bodies live in memory for one call and are written to no file, log, event or report; events carry numbers and enums only. A length cap bounds what is kept, it does not prove provenance: a mail shorter than 400 characters can be kept whole as its own summary, and this is accepted. | A schema test that no `mail.db` column is named or sized for a body; a run with a planted body sentence and a model reply that echoes it, then a search of the state directory, `mail.db`, `chamberlain.db` and the save file: the sentence appears only within the capped fields, never beyond the cap. |
| No credential is held | The provider is the mail tool (gog keeps its own keyring); `mail` config has no key, token or password field and `parseMail` rejects unknown keys; the provider child's environment is an allowlist without `GOG_ACCESS_TOKEN`, and its stderr is never stored (section 3). | Config tests; a test that a planted `GOG_ACCESS_TOKEN` reaches neither the child nor any log. |
| No pay-per-token lane | The model CLI's environment is an allowlist (section 4). | A test that plants each excluded variable (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) and asserts none reaches the child. |

**What is kept, and for how long.**

| Data | Where | Kept |
| --- | --- | --- |
| Provider message and thread id, from-address, `List-Id`, date, category, outcome, rule id, tier, tokens | `mail.db` `mail_messages` | 90 days |
| Subject, cut to 120 characters | `mail_messages.subject` | 30 days, then set to NULL |
| Summary (≤400 characters), facts, highlights (≤5 × 200 characters, with link) | the card's question in `chamberlain.db`, and `mail_cards` | 30 days after the card is answered. Queue items are history and are never pruned (`maintain.ts`), so B5 adds a core `scrubQuestion(id)` the module calls at 30 days: it replaces the card's title, context and option details with "mail card, text removed after 30 days" and keeps its kind, choice and times. A claim's stored message for a mail card holds no mail text (record-only); a note's answer wake is an outbox row, pruned 30 days after delivery as today. |
| Triage rules | `mail_rules` | for good (a ledger) |
| Run report | `reports/mail/` | 30 days |
| Mail bodies | memory, for one model call | never stored |
| Saved highlights | Nathan's notes | outside Chamberlain |

## 9. Questions for Nathan

Three, each one tap. Everything else above is decided and can be changed later.

| Question | Options (recommended first) | Why the recommendation |
| --- | --- | --- |
| When should triage run? | **Weekdays 07:30 and 16:30, plus whenever the Steward runs it** / only when the Steward runs it / every 3 hours, 07:00 to 19:00 | Two runs fit two reading moments and stay well inside the plan window; on-demand alone depends on the Steward remembering. |
| Where do saved newsletter highlights go? | **A "Reading list" note in your notes (Markdown)** / Readwise Reader / both | A local file involves no third party and fetches nothing; Reader can be added later as `save.command`. |
| May the model clean up mail with no rule yet, without a tap? | **No: model-only cleanup always waits for the one batch card** / yes, archive after a shadow fortnight in which you approved 95% of its batches | One tap a run is cheap, and confirmed rules take over the repeat cases quickly; it keeps every unattended action one you confirmed. |

## 10. Build pieces

| Piece | Issue | Needs |
| --- | --- | --- |
| B1 module seam: `src/modules/` and its registry, architecture rules, `parseMail`, `mail.db` and migrations, `src/core/llm/cli.ts` shared with the classifier | new | |
| B2 gog provider: the five verbs, the allowlist and flags, `label()` guards, partial-list errors; the `command` provider contract; a fake provider for tests; the real-binary refusal test | new | B1 |
| B3 rules stage, header facts, `important` routing, cursor and history, shadow recording | new | B1, B2 |
| B4 driver and escalation: batching, the reply schema, triggers, budgets and caps, env allowlist, `mail.attempt` events, rules-only mode | new | B1, B3; OBSERVABILITY B1 (registry) and B4 (`plan_usage`) when built, caps alone until then |
| B5 cards: `fileQuestion` and `scrubQuestion` in core, `route: "record"` with claim recovery and resolution, the answer handler, cleanup batch and ask cards, `mail_actions` and `mail undo` | new | B3, B4 |
| B6 learned rules: proposal from answers, backtest, confirm and retire, `mail rules list|retire` | new | B5 |
| B7 newsletter digests: link table, extraction, interest scoring, the card, `save.file` and `save.command` | new | B4, B5 |
| B8 scheduling and reporting: the timer, `mail run|pause|resume`, the lock, the report file, the `mail` wake kind and the sweep line | new | B3 |
| B9 a shadow fortnight on Nathan's mailbox, then measured token use and agreement with his taps, before `live` | new | B1 to B8 |

## 11. Review log

Sol review (reasoningEffort high), 2026-11-14: see the PR for findings and what was folded.
