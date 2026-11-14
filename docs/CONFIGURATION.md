# Configuration reference

Everything lives in two directories. The config directory is mode **0700**. In it, one file, `config.json`, holds every setting that is not a
secret, and one directory, `secrets/` (also 0700), holds a file per secret (mode **0600**: Chamberlain refuses a token or a URL that anyone else can read).

Coming from the file-per-setting layout of the first releases (`settings.json`, `servers.json`, `web.json`, one file per token)?
The daemon and the page **move** it for you the first time they start (secrets renamed into `secrets/`, the other files set aside as `<name>.migrated`).
[config-migration.md](config-migration.md) maps every old file and variable to its new place.

## Config directory `~/.config/chamberlain` (`CHAMBERLAIN_CONF`)

| Path | Required | What it is |
| --- | --- | --- |
| `config.json` | for the page, servers and anything beyond the defaults | Every setting that is not a secret: thread ids, the server list, the page, sweep checks, the Alert Desk, operating rules and the tunables below. Mode 0600 or 0644, owned by you, never group- or world-writable (it names commands the daemon runs). It has its own `schemaVersion` (now 1), and a key this build does not know is refused. |
| `secrets/` | T3 adapter: yes | One file per secret, mode 0600, in a 0700 directory. The names are listed below. A file is one value; a trailing newline is dropped. Never logged. |
| `decision-rights.md` | recommended | Your standing rules, in your words, verbatim in a wake whenever it may be new to the Steward (a one-line pointer otherwise). Without it a wake tells the Steward to hold anything on the ASK list. |
| `sweep-prompt.md` | optional | Replaces the bundled full-sweep prompt ([`steward-sweep-prompt.md`](steward-sweep-prompt.md)). `{{principalName}}` is substituted. |
| `alert-desk-prompt.md` | optional | Replaces the bundled Alert Desk prompt. |
| `operating-rules.md` | optional | Operating rules copied whole into the hand-off (the `operatingRules` section below is the other way). |
| `brief.d/*.md` | optional | Brief fragments: your own sections, appended to the Steward's hand-off. See below. |
| `daemon.env` | optional | `KEY=value` lines for systemd's `EnvironmentFile`. It stays where the unit files point; a variable in it overrides the key of the same name in `config.json`. |

The prose files stay files because you edit them as text. The away record, the rulings (ids R1, R2, ...), the butlers and everything held for your
return are rows in the database (below), written by `chamberlain afk`, `chamberlain ruling`, `chamberlain butler` and the page.

`chamberlain config show` prints the effective configuration, key by key, with where each value comes from (the environment, `config.json`, or an
old file still being read) and every secret by name; `chamberlain config migrate [--dry-run]` converts an old directory.

### `secrets/`

One file per secret, in the T3 adapter's names. A `tokenFile` or `operateTokenFile` in the config names a file in this directory.

| File | Required | What it is |
| --- | --- | --- |
| `read-token` | T3 adapter: yes (or a `tokenFile` per server) | An `orchestration:read` token for the default server. |
| `<name>-token` | per server | Any `tokenFile` or `operateTokenFile` a server entry, `web.decisionsServer` or `web.answerTokens` names. |
| `wake-url` | T3 adapter: to deliver | The webhook URL of the scheduled task bound to the Steward's thread. A URL that starts an agent turn is a secret. |
| `compact-url` | optional | Webhook whose task prompt is `/compact`. Without it the daemon only alarms that the Steward is over its size. |
| `desk-wake-url` | Alert Desk | The webhook bound to the Alert Desk thread. Without it the desk is off. |
| `web-token` | the page: made on its first start | The page's capability token: 32 random bytes. Every request to the page must hold it. `chamberlain web link` prints the page link that carries it (it is never put in a Decisions post), `chamberlain web rotate-token` replaces it. See [web-access.md](web-access.md). |
| `view-key` | the page: made on its first start | The view key: 32 random bytes, the only key a Decisions post carries. It is accepted only for what an inline frame may do (three reads and a plain answer) and never for a cookie, a page load, evidence, a card or a ruling. A start or `web rotate-token` never replaces it. See [web-access.md](web-access.md). |
| `wake-url.steward`, `wake-url.prev` | transient | Used by `chamberlain switch-steward` during a hand-off; the old URL is kept for one-rename rollback. |

After a migration a secret is read only from `secrets/`: a file written at the old path is never read (the daemon logs `config-legacy-reappeared`). Only a secret the migration never moved is still read from the config directory, with one `config-deprecated` line in the events log.

### `config.json`

```json
{
  "schemaVersion": 1,
  "principal": "Ada",
  "alertCmd": "~/bin/notify-me",
  "threads": { "steward": "<thread id>", "decisions": "<thread id>" },
  "servers": [ { "name": "main", "adapter": "t3", "origin": "http://127.0.0.1:3773", "tokenFile": "read-token" } ],
  "web": { "host": "127.0.0.1", "port": 3790 }
}
```

[`examples/config.json`](../examples/config.json) is a longer one. Setting a key to `null` says "none" and stops the fallback to an old file for that key.

**Scalar keys.** Each can be overridden by an environment variable, and **one rule names it: `CHAMBERLAIN_` + the key in UPPER_SNAKE_CASE**
(`stallMs` is `CHAMBERLAIN_STALL_MS`, `t3StateDb` is `CHAMBERLAIN_T3_STATE_DB`). The environment wins, then `config.json`, then the default.
A number that is not usable (`CHAMBERLAIN_MAX_ATTEMPTS=soon`) is ignored, not read as zero. A list is comma-separated, and a switch is `1` (on) or `0` (off): any other value is ignored.

| Key | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `principal` | `CHAMBERLAIN_PRINCIPAL` | `the operator` | What wakes, the hand-off and away mode call you. |
| `t3Dir` | `CHAMBERLAIN_T3_DIR` | `~/.t3` | T3's base directory (CLI under `bin/`, runtime under `runtime/versions/`). |
| `t3StateDb` | `CHAMBERLAIN_T3_STATE_DB` | `<t3Dir>/userdata/statev2.sqlite` | T3's state database, opened read-only. |
| `t3Origin` | `CHAMBERLAIN_T3_ORIGIN` | `http://127.0.0.1:3773` | The origin of the one default server when there is no `servers` list. |
| `alertCmd` | `CHAMBERLAIN_ALERT_CMD` | none | Run for each alarm as `<command> warning <title> <summary>`, with `CHAMBERLAIN_ALARM_KEY` (the alarm's stable key, to de-duplicate on) in its environment. Without one, alarms are only logged. |
| `compactTokens` | `CHAMBERLAIN_COMPACT_TOKENS` | `350000` | Steward context size above which the daemon sends `/compact`. |
| `recover` | `CHAMBERLAIN_RECOVER` | off | `true` (`1` in the variable): turn on stalled-thread recovery. The daemon classifies a failed run in code, retries a transient one once after a 3-minute grace, and sends a second failure to the judge (`judge`; without one, to the Steward unjudged). Needs the server's operate token. See [GLOSSARY.md](GLOSSARY.md#recovering-a-failed-thread). |
| `exclude` | `CHAMBERLAIN_EXCLUDE` | none | Thread ids to never wake about (a list; comma-separated in the variable). |
| `reportQuietMs` | `CHAMBERLAIN_REPORT_QUIET_MS` | `180000` | How long a finished turn must stay quiet before it is reported (a PR update often follows). |
| `reportHoldMs` | `CHAMBERLAIN_REPORT_HOLD_MS` | `3600000` | How long a report waits on a thread's own background work before it goes anyway. |
| `stallMs` | `CHAMBERLAIN_STALL_MS` | `1200000` | How long queued wakes may sit with nothing moving in the Steward's thread before an alarm. |
| `cardUnverifiedAlarmMs` | `CHAMBERLAIN_CARD_UNVERIFIED_ALARM_MS` | `86400000` (24 hours) | How long a question card the daemon holds may go with no evidence (not seen waiting, not seen resolved in its thread) before it raises an alarm naming the hold and the command that closes it by hand. |
| `maxAttempts` | `CHAMBERLAIN_MAX_ATTEMPTS` | `3` | The most attempts (POSTs) one outbox row gets, a positive whole number. Every outcome counts, a refusal and a timeout included. At the limit the row is a dead letter, kept and not sent again until `chamberlain wakes retry` or `cancel` (see [DELIVERY.md](DELIVERY.md#dead-letters)). |
| `gh` | `CHAMBERLAIN_GH` | `gh` | The command the held-for-return reconciler uses for its GitHub reads (`gh api <path> --jq <filter>`): another `gh`, or a wrapper that adds your credentials. |
| `healthFormatPattern` | `CHAMBERLAIN_HEALTH_FORMAT_PATTERN` | none | A regular expression enabling the optional reply-format health signal ([`steward-health.md`](steward-health.md)). |
| `stewardTokens` | `CHAMBERLAIN_STEWARD_TOKENS` | off | `true` (`1` in the variable): measure what the Steward spends per wake. The daemon re-reads the Steward's Claude Code transcript hourly and stores one row per wake (tokens and model requests, never text) in the database; `chamberlain steward-health tokens` reports tokens per wake by kind, the cost of a full sweep and the context trend, and `chamberlain steward-health tokens backfill` reads past Steward sessions. Off: nothing is read, stored or shown. See [`steward-health.md`](steward-health.md#tokens-per-wake). |

**Sections.** Objects and lists have no environment override.

| Key | What it holds |
| --- | --- |
| `threads` | `steward`, `decisions` and `desk`: the thread ids. `steward` is the Steward's thread (for another adapter, whatever id it uses for the Steward): the daemon never wakes the Steward about itself, and uses it for the busy gate, stall alarm and compaction. `decisions` is the pinned Decisions thread: `chamberlain ask` posts there and refuses to run without it. `desk` is the Alert Desk's thread, for its busy gate. `chamberlain switch-steward` writes `steward`. |
| `settledMatch` | How `chamberlain ask` and `chamberlain afk hold` decide a question is already settled ([ARCHITECTURE.md, "Queue first, hold second"](ARCHITECTURE.md#queue-first-hold-second-settled-never-twice)): `{"titleOverlap": true, "ignoreWords": []}`. `titleOverlap: false` matches on exact refs only; `ignoreWords` lists words (a project or product name) that head many unrelated questions and so say nothing about the topic. |
| `servers` | The T3 servers to watch. See below. |
| `web` | The page's bind address and options. See below. |
| `sweep` | Your own routine checks. See below. |
| `alertDesk` | The Alert Desk's settings: its windows and cap, the morning hour, and the commands and gatherer agent it may use. See [alert-desk.md](alert-desk.md). |
| `operatingRules` | Operating rules copied into the hand-off: excerpts of your own files. See below. |
| `mail` | The optional email triage module. Off by default. See [Email triage](#email-triage-optional) below. |
| `judge` | Which backend judges each trigger, with backend names of your own: `{"triggers": {"stalled-recovery": {"backend": "small-model"}}, "backends": {"small-model": {"command": [...]}}}`. A backend's command takes the system prompt and the user prompt as its last two arguments and prints `{"verdict", "reason"}`. There is **no default**: without it nothing is judged, the daemon logs `judge-off` with why at start, and a second failure goes to the Steward unjudged. Only error text, scrubbed, is ever sent. |

Errors from a section still name the old file the section came from (`web.json: no bind address`, `sweep.json: check disk needs ...`): read that as the `web` or `sweep` section of `config.json`.

**`operatingRules`** lifts the lines a Steward acts on out of your own markdown files when the hand-off
is built, so there is no second copy to drift (the value of the `operatingRules` key; [`examples/operating-rules.json`](../examples/operating-rules.json) is one on its own):

```json
{ "schemaVersion": 2,
  "intro": "The rest of these files is for builders. Read them when a rule seems missing.",
  "sources": [
    { "path": "~/notes/hosts/this-host.md",
      "sections": [ { "table": "Deltas", "rows": ["| `timeout`", "| Shell idioms"], "as": "On this host" } ] },
    { "path": "~/notes/OPERATING_RULES.md",
      "sections": [ ["Secrets", "whole"], ["Working style", ["- Whole issue", "- Smallest change"]] ] } ] }
```

- `operatingRules` has `sources`, read in order, and each one's selectors in order; `intro`, if set, comes first.
- `[heading, "whole" | [line prefixes]]` takes the `## heading` section, every line or one line per prefix.
  `{ "section": heading, "lines": ..., "as": heading }` is the same with a heading of its own.
- `{ "table": heading, "rows": "whole" | [row prefixes], "as": heading }` takes the one markdown table under `## heading`: its
  header and separator rows, then every body row or one row per prefix. Text around the table is left out.
- `{ "path": ..., "sections": "whole" }` copies that source whole. It is the only way a whole file reaches the hand-off.
- A heading that is gone or doubled, a prefix that matches no line or several, a wrapped rule, or a table that is missing,
  headerless or not alone under its heading stops that selector. It contributes **nothing**, with a `WARNING` on stderr
  naming the source, the selector and why; the source's other selectors and the other sources are still excerpted. (Until
  this release a failed excerpt copied the whole source instead, which could put text you never selected in front of the
  Steward.)
- The 0.1 form, `{ "source": path, "sections": [...] }`, still works: it is one source.

**`brief.d/`** (brief fragments): procedure that belongs to your project, not to Chamberlain, goes in `brief.d/` in the config
directory ([`examples/brief.d/`](../examples/brief.d/)), and `chamberlain brief steward` appends it to the generic hand-off:

- Only regular files whose names end in `.md` are used. A symlink, a directory or any other entry is ignored, with a
  warning on stderr. No `brief.d/` is fine.
- Fragments become the Steward's instructions, so they are checked like authority config. `brief.d/` must be a real
  directory (not a symlink), owned by you (the daemon's effective user), and not group- or world-writable; otherwise no
  fragment is read, with one warning. Each fragment must be owned by you and not group- or world-writable: `0600` and
  `0644` are fine, `0664` is not. A refused fragment is skipped with a warning naming it and why; the others are still
  used, and the hand-off always comes out. The same goes for one that cannot be read: a `brief.d/` you can write but not
  read (`0300`) gives no fragment, and an unreadable fragment is skipped, each with a warning naming the path and the
  error. With a umask of `002`, set the modes yourself:
  `chmod 755 brief.d && chmod 644 brief.d/*.md`.
- Fragments are sorted by filename in byte order (so `10-repo.md` before `20-landing.md`, and `B.md` before `a.md`), and
  each is appended verbatim, its own headings kept as written, after the generic brief and before any
  `## Open work at hand-over` section. Blank lines at a fragment's start and end are dropped, so fragments sit exactly one
  blank line apart. Nothing is substituted in a fragment.

**`servers`**: a list of server entries. One watcher runs per server, through the adapter the entry names; every wake carries `server:`. The Steward's own server (the one with no `environmentId`, else the first) is the one whose adapter wakes it.

| Field | Meaning |
| --- | --- |
| `name` | A short unique name used in wakes, queue items and logs. |
| `adapter` | Which adapter serves it (see [`ADAPTERS.md`](ADAPTERS.md)). Default `"t3"`. |
| `origin` | T3 adapter: the server's origin, for example `http://127.0.0.1:3773`. |
| `tokenFile` | T3 adapter: file in `secrets/` with an `orchestration:read` token. |
| `operateTokenFile` | Ignored by the page (answer rights come only from the `web` section); read by `chamberlain debug t3x`. File in `secrets/`. |
| `environmentId` | Set for a server other than the Steward's own: the Steward passes it to the `t3_*` tools. The one without it is "this server". |
| `linkEnvironmentId` | T3 adapter, optional: the environment id this server's thread links name. Default: `environmentId`, else the id the server reports at `/.well-known/t3/environment` (read in the background, never on the listing's path, and again every 6 hours; until the first read answers, its cards have no thread link). Set it on the Steward's own server only to skip that read: it does not make the server "linked". |
| `appScheme` | T3 adapter, optional: the URL scheme of the T3 Code app a thread's app link opens (`<appScheme>://threads/<environmentId>/<threadId>`). Default `t3code` (the App Store build); `t3code-preview` or `t3code-dev` for those builds. |
| `mayBeOffline` | A laptop that sleeps: no alarm when its socket stays down. |
| `sshHost` | `user@host` reachable by key-based ssh, so `git` can be asked about a worktree path on that machine. |

**`web`** (the page refuses to start without it):

| Key | Meaning |
| --- | --- |
| `host` | **Required.** The one address to bind: `127.0.0.1`, `::1`, an address in Tailscale's `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. Any other address, any host name and every wildcard is refused. |
| `port` | Default `3790`. |
| `allowedHosts` | Extra `Host` header names to accept, such as the machine's MagicDNS name. |
| `threadLinks` | Optional override. Server name to a prefix the URL-encoded thread id is appended to, for the thread link of a question asked with `chamberlain ask`. Without it a card's link is the server adapter's own (T3: `t3-thread://v2/<environmentId>/<threadId>`). An `http(s)` prefix (a T3 web URL) is also where "Open the thread" sends a device. |
| `mirrorLinks` | Optional override. Server name to a prefix the thread id is appended to, for a card read from a thread (`t3-thread://v2/<environmentId>/`). Without it the adapter's own link is used, as for `threadLinks`. |
| `decisionsServer` | `{ "origin": "...", "operateTokenFile": "..." }` (the token file is in `secrets/`): the T3 server hosting the Decisions thread, with an `orchestration:operate` token. Enables the "Decisions · N waiting" title and settling cards. |
| `answerTokens` | Server name to an operate-token file in `secrets/`: cards on that server become answerable from the page. Without one a server is read-only. |
| `publicBase` | An `https://` base (for example from `tailscale serve`) used in inline views when T3 is loaded over https. |

**Snooze, Direction and Dismiss.** Every question on the queue page has a quiet row of small buttons along its bottom edge: Open thread (the link that used to
sit with the crumbs), Snooze, Direction and Dismiss. A secret and a card pointer, which are settled in their own thread, get only the thread link and Snooze.

- **Snooze** offers 1 hour, later today, tomorrow morning, next week and a time of your own, as T3's thread snooze does. The page works each out in the browser's own
  time zone and sends an absolute time (within a year). A snoozed question leaves the active list for a **Snoozed** section, collapsed until you open it, with when each
  one returns and an Un-snooze button, and it comes back by itself at that time, even if Chamberlain was restarted in between. An urgent question is shown again in the Decisions thread when
  it returns (the daemon does that on its once-a-minute tick; a question with `"urgent": false` returns silently). It is not answered, so its afk hold stays open, with a note of the return time.
- **Direction** sends the note box's text and picks no option. It counts as an answer: the Steward gets a `[chamberlain] answer:` wake that says "direction, no option chosen" and carries
  the note, the question leaves the queue and its hold closes. It always goes to the Steward, never straight to the thread. The note is required.
- **Dismiss** ("already handled / no longer needed") asks first, takes the note box's text if there is any, closes the question and its hold, and sends the Steward a short wake that says dismissed. It is
  recorded as dismissed, not answered: it never counts as an answer or a ruling, and `ask` and `afk hold` never find it when they look for what is settled.

The Decisions view in T3 shows the same row as links that open the question on the full page, because the view may read and plain-answer a question and nothing else ([SECURITY.md](SECURITY.md)); its Snoozed section is read-only.

**Thread links.** Every card that comes from a thread links to it. The link is the adapter's (`threadLinks` and `mirrorLinks` above
override it per server, and only for a server that is in `servers`). A server whose environment is not known, and a thread id the
adapter does not issue (T3: a UUID, `mcp:<uuid>`, `mcp:launch:<64 hex>`, `thread:<kind>:...`, `import:<instance>:<session>`), get no
link rather than a wrong one. A page or view does not
put that link in front of a device as it is: no browser or phone opens `t3-thread://`. "Open the thread" is one of two links:

- **In T3 Code's phone app** the Decisions view is the top document of the app's own web view, and the app hands any link that is
  not `http(s)` to the phone's OS. So the view links straight to the thread's app link (T3: `t3code://threads/<environmentId>/<threadId>`),
  and the phone opens the thread in the app, in place: no browser, no page in between.
- **Everywhere else** (T3's web and desktop clients show the view in a sandboxed frame that opens only `http(s)`; the queue page in
  a browser) it goes to the page's own `/open/<server>/<threadId>` (signed in with `?k=` like any page link). A tap or click there
  is answered with a redirect straight to the thread's app link or `http(s)` override, so the browser hands it to the app in the
  same navigation (Safari on iPhone asks once, "Open in T3 Code?", as it does for every app link). A load that is not a tap (a
  reload, a link another app handed the browser, a browser older than Safari 16.4 that does not say) gets a short page that goes
  on by itself where the browser allows it and keeps an "Open" button, with a line saying to tap it if nothing opened.

Nothing to configure for the usual layout: the Steward's server reports its own environment, and every other server's entry
already names it. An `http(s)` `threadLinks`/`mirrorLinks` override for a server makes its views use `/open` everywhere.

**Expired secret requests.** A secret question (`chamberlain ask` with `secret: true`, or the daemon's pointer for a secret card)
shows "Request expired. Its secret box is closed: ask the thread to reopen it." once the card mirror's reads show no secret box
waiting in its thread (for a pointer: not its own box): read on a server the page mirrors, by a read that succeeded and began after
the question was asked. The question stays open: the thread still needs the value, and only the thread can open a new box. Answer
or close it as usual once that is done; a pointer still closes on its own when its card's item ends.

**`sweep`** lists your own routine checks, run every two hours:

```json
{ "sweep": { "checks": [ { "name": "disk", "command": ["/path/to/check-disk.sh"], "timeoutMs": 20000, "mode": "live" } ] } }
```

A check is an **item source** (the word is Nagios's and Sensu's: a command run on a schedule that reports a status): it
prints a JSON array of findings, `[{ "dedupKey": "disk-low", "text": "...", "repeatIntervalMs": 0 }]`, on stdout and exits 0,
and each finding becomes an item of source `check:<name>` in the one item system. `dedupKey` identifies it (unique within
the check; PagerDuty's `dedup_key`), and the item system alone decides when it notifies: once by default;
`repeatIntervalMs` notifies again that many milliseconds after each notification while the finding is still printed (`0`:
on every sweep; Alertmanager's `repeat_interval`), up to `maxNotifications` times; `baseline: true` makes the very first sweep
learn it silently; `subject: {"kind", "id"}` names what it is about (a pull request, a run). A finding the check stops
printing is resolved, so if it comes back it notifies again as new. A field this build does not know puts the check in
error, never quietly ignored. A check that fails or prints nonsense is in **error** (Grafana's Error state: the rule could
not be evaluated, which is different from No Data): its findings keep their state, an `evaluation_error` item notifies on
every sweep until it runs again, and the sweep becomes a full one, because a check in error must never read as a clear one.
`"mode": "shadow"` on a check records what it *would* have sent without waking anyone (counted apart from real
notifications, so going `"live"` starts from a true zero); `"silenced"` tracks only. Findings travel to the Steward as untrusted data. See
[`examples/sweep-check.sh`](../examples/sweep-check.sh). The daemon also runs one built-in source, threads that keep starting
turns of their own (a runaway), with no configuration, and one built-in check on its own timer, `idle-parents`, described next. Any future monitor plugs in the same way, as another source
([`ARCHITECTURE.md`](ARCHITECTURE.md#the-item-system)).

**`sweep.idleParents`** tunes the built-in `idle-parents` check (item source `check:idle-parents`). It runs on **its own timer**, every
`intervalMinutes` (default 15), not on the two-hourly routine sweep; the daemon's once-a-minute housekeeping asks whether it is due, and
the check keeps its own clock in the database, so the schedule survives a restart. Each run lists the top-level threads on every
configured server that are not a child or subagent thread, not settled, snoozed or archived, have nothing running or open (no card,
background task, running child, or running subagent the adapter reports), and are `idle` or `completed` with their last message finished more than `thresholdMinutes` ago
(default 30), whoever started its last turn: a thread that answered the principal's own question and then sat on a half-answer is listed like any other. The Steward's own thread, the decisions thread, the Alert Desk thread and the `exclude` list are never listed. The
Steward gets one wake with a compact list: server, thread id, title, idle minutes and the last message cut to about 300 characters,
with the threads whose last message asks something (`looksLikeAsk`, so "say go and I'll start it" counts) marked `[ASKING]` and
first. It is the net under a turn-end wake that missed a thread. A thread is reported once per last message, however many runs pass and however its eligibility moves in between (snoozed, briefly
running, below the threshold: it comes back unreported only if its last message changed; the item's key is the thread plus a hash of
that message); a new message makes a new report. It calls no model: the selection is plain
code (`selectIdleThreads` in `src/core/idle-parents.ts`, which returns plain records).

```json
{ "sweep": { "idleParents": { "enabled": true, "intervalMinutes": 15, "thresholdMinutes": 30, "maxThreads": 10 } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the check off. |
| `intervalMinutes` | `15` | A positive number of minutes between runs. The housekeeping tick is once a minute, so a run starts within a minute of when it is due. |
| `thresholdMinutes` | `30` | A positive number of minutes a thread must have been idle. |
| `maxThreads` | `10` | The most NEW threads one wake lists, asks first, then the longest idle; the rest are listed on a later run. A thread already reported never counts again. |

A key it does not know is refused. A configured check cannot be named `idle-parents`. The check reads each candidate thread's last
message, so it needs an adapter whose `inspect` has `lastAssistant` (the T3 adapter does); without it the check lists nothing.

### The idle-thread classifier

**`sweep.idleParents.classifier`** is optional and **off by default** (`provider: "none"`): without it the check behaves exactly as
above and makes no model call. Turned on, it asks a bank of narrow yes/no questions about each idle thread's last message, combines
the answers in code into one action, and (in `live` mode) reports only the threads that need someone. The design and the evaluation
behind it are in [`design/thread-state-classifier.md`](design/thread-state-classifier.md).

| Action | Meaning | In `live` mode |
| --- | --- | --- |
| `escalate` | Someone has to decide or do something before work can continue. | Reported first, tagged `[ESCALATE asks_decision 0.98]` with the questions that fired. |
| `nudge` | The thread owes work it has no way to resume. | Reported next, tagged `[NUDGE …]`. |
| `settle` | Finished; nothing is owed. | Not reported one by one: at most one digest line a day counts them. |
| `ignore` | Legitimately waiting (a watch it set is young enough to believe), or nothing matched. | Not reported. |
| `unknown` | Not classified: the provider failed, an answer was malformed, the redaction hook failed, or the budget is spent. | Reported exactly as without the classifier. A failure never silences the net. |

Precedence is fixed in code, `escalate > nudge > settle > ignore`; the model never picks the action. `partial_answer` counts only
when the message before the last one is a human's, and `promises_more_work` and `waiting_external` are held (ignore) while the
thread claims an armed wait and has been idle less than `armedGraceMinutes`; `waiting_external` never fires when `work_finished`
does. In `shadow` mode (the default once a provider is on) every thread is classified and recorded, and the wake is exactly as
without the classifier: run it that way first, and compare the dispositions with what you would have done.

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
        "jev": { "model": "jev-1.14.0", "keyFile": "typesafe.key", "timeoutMs": 10000 },
        "haiku": { "command": "claude", "model": "haiku", "timeoutMs": 60000 }
      }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `none` | `none` (off), `rules` (regular expressions, nothing leaves the machine), `jev` (TypeSafe's Jev, the recommended one: one HTTP request per thread, every question a head in it), or `haiku` (the `claude` CLI with `--model haiku`, on your own Claude Code login). |
| `mode` | `shadow` | `shadow`: classify and record, report as without the classifier. `live`: report only escalate, nudge and unknown, tagged. |
| `allowTextToLeaveMachine` | `false` | Must be `true` for `jev` or `haiku`, which send thread text off the machine; either without it is refused at load. |
| `questions` | `default` | `default` (the evaluated bank, `src/core/classifier/questions.default.json`) or the path of a bank file, relative to this directory. |
| `thresholds` | `{ "default": 0.5 }` | The probability at or over which a question counts as yes: `default`, and per question id. A threshold for an id the bank does not have is refused. |
| `send` | `1500`, `400`, `true` | `lastChars` of the last message, `previousChars` of the user message before it, and whether the thread title (at most 200 characters) goes. Every cut is made well-formed Unicode. |
| `redact` | `true`, `null` | `builtin`: replace emails, API-key and token shapes, JWTs, phone numbers and home-directory user names, found in the whole message so a long token that starts before the cut is still caught. `command`: `["program", "arg", …]`, given the state as JSON on stdin; it must print the same shape within 5 seconds, or nothing is sent and the thread is `unknown`. |
| `budget` | `20`, `500`, `0.25` | `maxPerRun`: the most classifications one run makes (the rest are `unknown` this run, classified on a later one). `maxCallsPerDay` and `maxUsdPerDay`: for `jev` and `haiku`, every attempt in the UTC day counts, a retry of a failed call included, and so does the cost a failed but billed call reports (counted in the database as each call is made, and never less than the disposition table's own sum); when either is spent, unclassified threads are `unknown` until the next UTC day. Up to three calls already under way can finish past the dollar ceiling. |
| `armedGraceMinutes` | `360` | How long a thread's claim that a watch or timer will wake it is believed. An idle parent has no running background task, so a claim older than this has lost its wait. |
| `jev` | see above | `model` (pinned; the model the API reports is recorded, and a reported id that is not a short token is refused, so no echoed text is stored), `keyFile` (a file name in `secrets/`, mode 0600, read by the daemon at each call and never logged), `timeoutMs`. |
| `haiku` | see above | `command`, `model`, `timeoutMs`. `ANTHROPIC_API_KEY` is removed from its environment, so it runs on your plan; the thread text goes on stdin. |

`autoNudge` and `autoSettle` are designed (acting on a thread without the Steward) but not in this build: only `false` is accepted.
Anything else the section does not know is refused, and a refusal puts the sweep section in error, so the check runs with the
classifier off rather than guess.

**Classified once per message.** Each attempt is a row of `thread_dispositions`, keyed by server, thread, the hash of its last message
and the bank version (a hash of the bank, the thresholds, the provider and its model, and the send and redact settings). An idle
thread's last message does not change, so a run at steady state makes no call; changing any of those settings reclassifies on the
next run. A failed attempt is retried on the next run. The table holds answers, reasons, characters sent and redactions made, cost
and latency, and **no message text**; its `feedback` and `corrected_action` columns mark a disposition right or wrong, and those
rows are kept past the 30-day retention as the next evaluation set. A bank file is a JSON array of
`{id, ask, yes, no, fires: "escalate"|"nudge"|"settle"|"modifier", requires?, unless?, rules?}`: `requires` takes structural facts
(`human_asked`), `unless` other question ids (a `modifier` there holds a nudge while the thread is younger than the grace), and
`rules` regular expressions or the builtins `@ask`, `@stall` and `@otherwise` for the `rules` provider.

### Email triage (optional)

**`mail`** is optional and **off by default**: without the section, or with `"provider": "none"`, Chamberlain runs exactly as it does
without the module, and no `mail.db`, timer, child process or event exists. The design is [EMAIL-TRIAGE.md](EMAIL-TRIAGE.md); what is
built so far is the seam (issue #34): the section is parsed and checked, `chamberlain mail` and the daemon start the module, and
`mail.db` is made. **It reads and changes no mailbox yet**; the provider, the pipeline, the cards and the schedule are issues #35 to #42.
A key it does not know is refused at start, naming it, and there is no key for a credential: the mail tool (`gog`, a mail client) keeps
its own login and Chamberlain never sees it. Mail text leaves the machine only with two switches: a provider other than `"none"` with a
reading model (`models.driver` anything but `"none"`) **and** `allowMailToLeaveMachine: true`; without the second the section is refused.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `"none"` | `"none"` (off), `"gog"` (Gmail through the `gog` tool) or `"command"` (your own program speaking the provider verbs as JSON). |
| `mode` | `"shadow"` | `"shadow"` runs everything and changes nothing in the mailbox; `"live"` lets confirmed rules and tapped cards act. |
| `allowMailToLeaveMachine` | `false` | The second switch above. |
| `gog` | `{command: "gog", account: null, timeoutMs: 60000, env: []}` | `env` lists extra variable names the `gog` child may inherit (a keyring's); `GOG_ACCESS_TOKEN` is refused there. |
| `command` | `{argv: null, timeoutMs: 60000}` | The program for `provider: "command"`: `["program", "arg", ...]`. |
| `scope` | `{query: "in:inbox", lookbackDays: 7, maxMessagesPerRun: 200}` | Which mail a run looks at. |
| `schedule` | `{times: ["07:30", "16:30"], days: "mon-fri", tz: "local", maxRunsPerDay: 4}` | When a run starts: 24-hour `HH:MM` times (an empty list: only the Steward starts one), `"daily"` or days such as `"mon-fri"` or `"mon,wed,fri"`, `"local"` or an IANA zone. |
| `labels` | `{prefix: "Chamberlain"}` | Every label the module adds is `<prefix>/<name>`; the prefix is a plain name with no `/`. |
| `models` | `{command: "claude", driver: "haiku", escalate: "sonnet", top: "opus"}` | The model tiers, by the CLI's own model names. `driver: "none"` is rules only: no model is called and no text leaves. |
| `budget` | `{driverCallsPerRun: 10, escalateCallsPerRun: 8, newsletterCallsPerRun: 3, topCallsPerRun: 0, inputTokensPerDay: 600000}` | Per-run and per-day caps; `topCallsPerRun` is 0 or 1. |
| `important` | `{senders: [], words: ["invoice", "due", "contract", "tax", "court", "overdue"]}` | Senders (an address or `@domain`) and subject words whose mail is never cleaned without a tap. |
| `newsletters` | `[]` | `[{"name": ..., "match": {"listId": ...} or {"sender": ...}, "maxHighlights": 1 to 5}]`. |
| `interests` | `[]` | Topics highlights are scored against. |
| `routes` | one route, `steward` | Where a picked highlight goes. Each is `{"id", "label", "kind"}` with `kind` `"steward"` (a task for the Steward), `"file"` (add `"file"`: Markdown is appended to it) or `"command"` (add `"command": ["program", ...]`: given the highlight as JSON on stdin, run only on a tap; **it is your own program and may fetch what it is given, so it is outside the module's no-fetch guarantee**). A route is added by writing it here, with no code. |
| `defaultRoute` | the first `file` route, else the first route | The route offered first until a route has been learned for that kind of item. Must be one of `routes`. |
| `cleanup.unattended` | `{minApproval: 0.95, shadowDays: 14, minBatches: 10, sampleRate: 0.25, sampleWindow: 8}` | The numbers of the unattended-archive mode, which is **off on every install and has no switch here**: it is turned on only by a measured shadow trial and the Steward's confirmation (EMAIL-TRIAGE.md, sections 5 and 8). The first three are floors: a weaker value is refused. |

`chamberlain mail` (or `mail status`) says the module is off, or prints what is in force and makes `mail.db`.

## State directory `~/.local/state/chamberlain` (`CHAMBERLAIN_STATE`)

Chamberlain follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). The state
directory is `$CHAMBERLAIN_STATE`, else `$XDG_STATE_HOME/chamberlain`, else `~/.local/state/chamberlain` (an empty or
relative variable is ignored, as the specification says). It holds what the processes write while they run and what must
survive a restart: **this is data you keep, not a cache**, because the rulings and the decision log are in it. The config
directory follows the same rule (`$CHAMBERLAIN_CONF`, else `$XDG_CONFIG_HOME/chamberlain`, else `~/.config/chamberlain`).
Chamberlain keeps no cache files today; `$XDG_CACHE_HOME/chamberlain` is reserved for any it might, and is safe to delete.

```
~/.config/chamberlain/        what you write: config.json, secrets/ (a file per token or URL, mode 0600), decision-rights.md
~/.local/state/chamberlain/   what Chamberlain writes, and what a backup must keep
  chamberlain.db              the one SQLite database (mode 0600), with chamberlain.db-wal and -shm beside it while it is open
  mail.db                     only with the optional `mail` module on: its own database, same rules (mode 0600, WAL)
  evidence/<item>/            the screenshots and recordings the database's evidence rows point to
  steward-brief.md            the Steward's hand-off
~/.cache/chamberlain/         nothing: reserved for real caches
```

All state is one SQLite database, `chamberlain.db`, opened in WAL mode with a busy timeout and foreign keys on, mode 0600.
The daemon, the page and the command-line tools open it at the same time and never lose each other's writes.

**One daemon per database.** The daemon holds a `flock(2)` exclusive lock on the state directory, the directory that holds
`chamberlain.db`, for as long as it runs; there is no lock file. A second daemon on the same directory exits 5, whatever the
environment or the spelling of the path. The kernel frees the lock when the daemon dies, however it dies. The lock is on the
directory rather than the database because on macOS `flock` and SQLite's own `fcntl` locks conflict on the same file; SQLite never
locks the directory, so the page and the tools work as usual on Linux and macOS. It holds on a local filesystem only (a network
filesystem is unsupported). A database with a second hard link is refused at start, and a database replaced, deleted or moved to
another directory under a running daemon is a different database. Where `flock` cannot be called through `bun:ffi`, the daemon
refuses to start and exits 1.

**Backup.** Back up `chamberlain.db` and `evidence/`, not the files loose and not the cache directory. Copy the database
only after the processes have exited (so the `-wal` file is merged), or take a consistent copy while it runs with
`sqlite3 ~/.local/state/chamberlain/chamberlain.db "VACUUM INTO '/path/to/backup.db'"`. `rsync`, `cp -r` or a snapshot of
the state directory taken while the daemon is writing can catch the database and its `-wal` file at different moments.

| Where | What it is |
| --- | --- |
| table `items` | The one item system: sweep findings, decision-queue questions, alarms, the notification log of what already woke the Steward, what is held for your return. |
| tables `claims`, `relays`, `evidence` | A question's answer flow: the one-wake claim (unique per item, carrying the wake text and its delivery id), the one direct send of a thread-routed answer, and rows pointing at its evidence files. |
| tables `outbox`, `outbox_members`, `held_wakes`, `wake_tombstones` | The transactional outbox: one row per wake to send (`pending`, `delivered`, `dead_letter` or `cancelled`), the delivery ids each row carries (bound to that row for good), turn ends and sweeps held while the Steward is busy, which become one digest row, and one permanent tombstone per delivery id that was delivered or cancelled, which outlives retention of its row. |
| tables `rulings`, `decisions`, `butlers`, `away` | The rulings ledger (with each ruling's expiry, what it supersedes and why it left force), the Steward's self-answers, the butler ledger and the away record. |
| table `events` | The log: every wake, skip, alarm and answer. `chamberlain debug queue-waits` and the return brief read it with SQL. |
| table `state` | Small named records: the sweep clock, what rights text the Steward last received, the latest health verdict, the heartbeat. |
| table `migrations` | The schema's version history (see [ARCHITECTURE.md](ARCHITECTURE.md)). |
| `mail.db` (beside the database; only with the `mail` module on) | The email triage module's own database, with its own `migrations` table. It holds ids, addresses, dates, outcomes and capped derived text, never a mail body. Created on the first start with the module on, never before; remove the `mail` section and this file to delete the module's data. |
| `evidence/<item>/` (a directory beside the database) | Screenshots and recordings copied in by `chamberlain ask`; the page serves only the names an item's `evidence` rows list. These stay files. |
| `steward-brief.md` (beside the database) | The Steward's hand-off (where `/steward-handoff` writes it). |

## Environment variables

**The naming rule.** A scalar key of `config.json` is overridden by `CHAMBERLAIN_` + its name in UPPER_SNAKE_CASE; the
table under "Scalar keys" above lists them all. The daemon, the page and the command-line tools all read them. These are the ones
that are not config keys:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAMBERLAIN_CONF`, `CHAMBERLAIN_STATE` | `$XDG_CONFIG_HOME/chamberlain`, `$XDG_STATE_HOME/chamberlain` (else `~/.config/chamberlain`, `~/.local/state/chamberlain`) | The two directories. They name where `config.json` is, so they are never keys in it. Point them at scratch directories to try things out without touching your real ones. |
| `CHAMBERLAIN_DRY` | unset | `1`: the daemon watches and logs, and posts nothing. A switch for one run, so not a key. |
| `CHAMBERLAIN_VERBOSE` | unset | Also print each log line to stdout. |
| `CHAMBERLAIN_ALARM_KEY` | set by Chamberlain | Not for you to set. It is in the environment of your `alertCmd` when Chamberlain runs it: the alarm's stable key (for example `steward-stalled`), so a command that pages someone can de-duplicate on it. |
| `T3CODE_CLI_PATH` | auto | The `t3` binary `chamberlain ask` uses; otherwise `<t3Dir>/bin/t3`, then the newest installed runtime. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where to find the Steward's Claude Code transcripts for health measurement. |
| `ALERT_DESK_INBOX` | `~/.cache/alert-desk/inbox.jsonl` | The Alert Desk's inbox file. See [alert-desk.md](alert-desk.md). |
| `DESK_ASK_PATH` | unset | The Alert Desk files a decision with `bun $DESK_ASK_PATH`; unset, with this build's own `chamberlain ask`. The hook and the standing prompt must see the same value. See [alert-desk.md](alert-desk.md). |
| `DESK_LOG_DIRS` | unset | Colon-separated extra directories the Alert Desk may read files from, besides `/var/log` and `~/.cache/alert-desk`. |

The `ALERT_DESK_*` and `DESK_*` variables belong to the Alert Desk's own processes (its hook and its writers), which are not Chamberlain's, so they are not keys.

## Command-line tools

The standalone binary is one command, `chamberlain <name>`; from a checkout each is `bun src/<file>`, for example `bun src/ask.ts`.
`chamberlain help` lists them. Everything the Steward's hand-off and wakes teach is built with the spelling of the running build.

| Command | Used by | Does |
| --- | --- | --- |
| `chamberlain daemon` | you | The watcher, and the one process that sends wakes. One per state directory: a second exits 5. |
| `chamberlain web [--test]` | you | The decision-queue page. `--test` serves fixture data on loopback and sends no wake. Every request needs the page's key ([web-access.md](web-access.md)). |
| `chamberlain web link`, `web rotate-token` | you | `link` prints the page's links with the key on them (one to open on a phone or laptop, one script tag, with the view key, for the Decisions thread's setup message). `rotate-token` makes a new key: every old link, cookie and rendered view stops working at once, and the new links are printed. |
| `chamberlain ask '<json>'` | the Steward | Put one question on the queue and in the Decisions thread (the view it posts carries the view key, never the page's key). `proposedRuling` is the ruling you may save with your answer; add `proposedExpires` (a date or a date-time with a zone) when it is about one run, launch or week, and the saved ruling expires by itself. `"urgent": false` lists it below the urgent ones and posts nothing. A question already settled (an answer, a ruling, a logged decision) is refused with exit 2 and what it matched on; `"notSettled": "<why>"` overrides it. |
| `chamberlain ruling [--stated-in-chat] [--expires <ISO>] [--until "<event>"] [--supersedes R32,R16] [--] "<words>" "<decides>"` | the Steward | Record a proposed (or, stated in chat, in-force) ruling. Recording the same words and decision again adds nothing and prints the id already held. `--expires` (a date, through the end of that day UTC, or a date-time with a zone) makes it time-bound: it drops out of every wake after that and the rulings page marks it expired. `--until` is a note for a bound only a person can judge, shown and never enforced. `--supersedes` names the rulings it replaces: they leave force when this one is in force. `list` shows every ruling. |
| `chamberlain decided "<thread>" "<decision>" "R12: why"` | the Steward | Log a self-answer, citing rulings by id. `decided list [n]` shows the last n. |
| `chamberlain afk enter\|status\|hold\|held\|note\|close\|close-card\|brief\|exit` | you, the Steward | Away mode and the held-for-return ledger. `hold` requires `--item <Q-id>` of an open question (queue first, hold second) and takes `--not-settled "<why>"`, `--pr`, `--issue`, `--branch`, `--run`, `--thread`; it refuses a wait already settled. The daemon closes a hold when its item is answered or its PR, issue, branch or thread is done. GitHub reads use `gh` (or `CHAMBERLAIN_GH`). |
| `chamberlain brief steward [--mode test\|live]` | you | Print the Steward's hand-off. |
| `chamberlain brief start`, `brief wake-prompt` | you | The first message of a new Steward thread, and the prompt of its wake task: both with this build's commands, from files inside it. |
| `chamberlain brief desk` | you | The Alert Desk's standing prompt, filled in from your config ([alert-desk.md](alert-desk.md)). |
| `chamberlain wakes list\|retry <id>\|cancel <id>` | you | The outbox: what is pending, held and dead-lettered; retry a dead letter; cancel a row for good. See [DELIVERY.md](DELIVERY.md#dead-letters). |
| `chamberlain butler start\|stop\|list` | the Steward | The butler ledger. |
| `chamberlain steward-health` | you | Read-only Steward health report. |
| `chamberlain config migrate\|revert [--dry-run]`, `config show`, `config get <key>` | you | `migrate` MOVES the old file-per-setting layout into `config.json` and `secrets/`; `revert` puts it back so an older build starts; `--dry-run` prints what it would do. `show` prints every key with where its value comes from, every secret by name, and flags any old file written again after the move. `get <key>` prints one value for a script (`threads.steward`, `web.port`), never a secret. See [config-migration.md](config-migration.md). |
| `chamberlain migrate [--check]` | you | Check every old-layout config file's schema version and upgrade old ones. (The database migrates itself when opened.) |
| `chamberlain mail [status]` | you | The optional email triage module: says it is off, or prints what is in force and makes `mail.db`. Reads and changes no mailbox yet. |
| `chamberlain switch-steward <threadId>` | the Steward | The last step of a hand-off: make this thread the wake target. |
| `chamberlain debug <command>` | you | Diagnostic commands, listed by `chamberlain debug help`: `peek <server> <threadId>` (the end of a thread in plain lines, a tenth of what `t3_thread_read` costs), `t3x threads\|read\|respond\|send <server>` (act on a thread on any configured server), `queue-waits [--hours N] [--store FILE]` (how long wakes sat before the Steward started on them), `compat [origin]` (a T3 server's version and whether it is in the tested range), `synthetic-wake` (queue one wake shaped like the daemon's, as an outbox row, so the running daemon sends it and the whole path is proved), `desk-allowlist hook\|check '<command>'` (the Alert Desk's command allowlist). The old top-level names (`chamberlain peek`, and so on) still work. |
