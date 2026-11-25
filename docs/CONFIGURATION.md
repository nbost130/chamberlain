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
| `view-key` | the page: made on its first start | The view key: 32 random bytes, the only key a Decisions post carries. It is accepted only for its allowlist (three reads, an answer that is a choice only, snooze, un-snooze, direction and dismiss on a queue item, and the `GET /open/<server>/<threadId>` redirect to a thread's app link, which sets no cookie: `src/web/view-key.ts`) and never for a cookie, a page load, evidence, a card or a ruling. A start or `web rotate-token` never replaces it. See [web-access.md](web-access.md). |
| `steward/<id>.wake`, `steward/<id>.compact` | switch-owned | Written by the successor during `chamberlain steward prepare`; immutable per switch. Shared `wake-url.steward` names are ignored. |

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
| `compactTokens` | `CHAMBERLAIN_COMPACT_TOKENS` | `130000` | Steward context size above which the daemon sends `/compact`. |
| `recover` | `CHAMBERLAIN_RECOVER` | off | `true` (`1` in the variable): turn on stalled-thread recovery. The daemon classifies a failed run in code, retries a transient one once after a 3-minute grace, and sends a second failure to the judge (`judge`; without one, to the Steward unjudged). Needs the server's operate token. See [GLOSSARY.md](GLOSSARY.md#recovering-a-failed-thread). |
| `exclude` | `CHAMBERLAIN_EXCLUDE` | none | Thread ids to never wake about (a list; comma-separated in the variable). |
| `reportQuietMs` | `CHAMBERLAIN_REPORT_QUIET_MS` | `180000` | How long a finished turn with outstanding children or background work must stay quiet before it is reported (a PR update often follows). A clean completion (nothing still running) skips this window. |
| `reportHoldMs` | `CHAMBERLAIN_REPORT_HOLD_MS` | `3600000` | How long a report waits on a thread's own background work before it goes anyway. |
| `stallMs` | `CHAMBERLAIN_STALL_MS` | `1200000` | How long queued wakes may sit with nothing moving in the Steward's thread before an alarm. |
| `cardUnverifiedAlarmMs` | `CHAMBERLAIN_CARD_UNVERIFIED_ALARM_MS` | `86400000` (24 hours) | How long a question card the daemon holds may go with no evidence (not seen waiting, not seen resolved in its thread) before it raises an alarm naming the hold and the command that closes it by hand. |
| `maxAttempts` | `CHAMBERLAIN_MAX_ATTEMPTS` | `3` | The most attempts (POSTs) one outbox row gets, a positive whole number. Every outcome counts, a refusal and a timeout included. At the limit the row is a dead letter, kept and not sent again until `chamberlain wakes retry` or `cancel` (see [DELIVERY.md](DELIVERY.md#dead-letters)). |
| `gh` | `CHAMBERLAIN_GH` | `gh` | The command the held-for-return reconciler uses for its GitHub reads (`gh api <path> --jq <filter>`): another `gh`, or a wrapper that adds your credentials. |
| `healthFormatPattern` | `CHAMBERLAIN_HEALTH_FORMAT_PATTERN` | none | A regular expression enabling the optional reply-format health signal ([`steward-health.md`](steward-health.md)). |
| `stewardTokens` | `CHAMBERLAIN_STEWARD_TOKENS` | off | `true` (`1` in the variable): measure what the Steward spends per wake. The daemon re-reads the Steward's Claude Code transcript hourly and stores one row per wake (tokens and model requests, never text) in the database; `chamberlain steward-health tokens` reports tokens per wake by kind, the cost of a full sweep and the context trend, and `chamberlain steward-health tokens backfill` reads past Steward sessions. Off: nothing is read, stored or shown. See [`steward-health.md`](steward-health.md#tokens-per-wake). |
| `rightsInline` | `CHAMBERLAIN_RIGHTS_INLINE` | on | `false` (`0` in the variable) sends a standalone full-rights wake ahead of a row the record says the Steward may not hold the rights for (the old way). On: the full block rides inside that row's own wake, so no Steward turn is spent only to receive it; the stored row is never edited and the delivered commit writes the rights record as before. |
| `wakeDebounceMs` | `CHAMBERLAIN_WAKE_DEBOUNCE_MS` | `180000` | How long held turn ends, notes and sweeps wait for company when the Steward is idle, so several go as one digest instead of one turn each. `0` sends them at once (the old way). An answer, a transfer or any other kind held beside them sends the whole batch immediately; needs_input, failures and messages are never held by this wait (a question card in a thread the principal is writing in has its own, `activeHold`), and when one goes at once it carries the held news in the same wake (`news-carried`), so the news never goes as a second turn. Logged as `wake-debounced`. |
| `rightsNoticeRetries` | `CHAMBERLAIN_RIGHTS_NOTICE_RETRIES` | `3` | A Steward row too large to carry the "hold any action that needs the rights" notice beside it is preceded by the notice as a tiny wake of its own. After this many failures of that wake (or 15 minutes) the `rights-notice-undelivered` alarm is raised and the notice is prepended to the row's own text, even past the soft size bound, so the row is never held at 0 attempts. |

**Sections.** Objects and lists have no environment override.

| Key | What it holds |
| --- | --- |
| `threads` | `steward`, `decisions` and `desk`: the thread ids. `steward` is the Steward's thread (for another adapter, whatever id it uses for the Steward): the daemon never wakes the Steward about itself, and uses it for the busy gate, stall alarm and compaction. `decisions` is the pinned Decisions thread: `chamberlain ask` posts there and refuses to run without it. `desk` is the Alert Desk's thread, for its busy gate. `chamberlain switch-steward` writes `steward`. |
| `settledMatch` | How `chamberlain ask` and `chamberlain afk hold` decide a question is already settled ([ARCHITECTURE.md, "Queue first, hold second"](ARCHITECTURE.md#queue-first-hold-second-settled-never-twice)): `{"titleOverlap": true, "ignoreWords": []}`. `titleOverlap: false` matches on exact refs only; `ignoreWords` lists words (a project or product name) that head many unrelated questions and so say nothing about the topic. |
| `ideas` | Idea-card admission limits. Defaults: `{"timeZone":"UTC","dailyCap":2,"perThreadDailyCap":1,"openCap":5,"declineDays":30}`. The IANA zone defines midnight for both daily caps. The caps count filings even after closure, and the open cap includes snoozed ideas. Thread identity is scoped to the server and uses the thread title if no ID is available. Each limit is a non-negative integer. A cap of zero closes admission. |
| `servers` | The T3 servers to watch. See below. |
| `models` | Explicit provider/model/effort selections for pinned threads and isolated readers. No defaults or silent fallback. See [Model configuration and inventory](MODELS.md). |
| `builderProfiles` | Named host pools, capacities and ordered model candidates for Worker and Butler. Select a shared profile with `models.worker.profile` or `models.butler.profile`. See [Builder placement at launch](MODELS.md#builder-placement-at-launch). |
| `overhead` | What the Steward and Chamberlain cost against the work that got done, and the limits that open an investigator thread. Off and neutral by default. See [Overhead monitor](#overhead-monitor). |
| `web` | The page's bind address and options. See below. |
| `sweep` | Your own routine checks. See below. |
| `alertDesk` | The Alert Desk's settings: its windows and cap, the morning hour, and the commands and gatherer agent it may use. See [alert-desk.md](alert-desk.md). |
| `operatingRules` | Operating rules copied into the hand-off: excerpts of your own files. See below. |
| `mail` | The optional email triage module. Off by default. See [Email triage](#email-triage-optional) below. |
| `activeHold` | Whether a question card in a thread the principal is writing in waits for them before it wakes the Steward: `{"enabled": true, "windowMinutes": 5}`, both optional (the values shown are the defaults; `windowMinutes` is a whole number from 1 to 60). When a card is raised in a thread where the principal sent a message within `windowMinutes`, the wake is held until that message plus the window. If the card is still unanswered then, the Steward is woken as for any needs_input wake, and the wake says the principal had their window, so the Steward answers it under its decision rights or queues it as a Decision for them; if T3's record shows every one of its cards resolved (by anyone: T3 does not record who resolved a card), or its thread is archived, settled or snoozed, the wake is dropped, at the next tick after that rather than at the due time. A card that is merely missing from T3's bounded snapshot is not evidence of anything: it wakes the Steward at its time. A card released at its time goes through the same routing a fresh card gets: if the principal has gone away meanwhile and it is a card only they can clear (an approval, a secret, a machine link), the daemon holds it for their return and the Steward is not woken. A thread the principal has not written in, a card raised while they are away (and every held card when they go away), and the Steward's, Decisions and Alert Desk threads wake at once, as before. Only a message from T3's `web` or `mobile` client counts as the principal's; a message with any other or no source (the daemon's and tools' posts as them included) does not. If the principal's activity cannot be read for a thread (the server is down, a token is refused, the read takes over 5 seconds), the card wakes the Steward at once; the same 5 seconds bound every read the engine makes later to settle a parked card, and one card never holds up another, exactly as without this setting, and `active-hold-unavailable` is logged with the error class and the server. It works on every configured server, each read over that server's own address and token. Held cards live in the database, so a restart releases one past its time at once. Logged as `active-hold-held`, `active-hold-released` (`due` or `away`) and `active-hold-dropped` (`answered`, `left` or `held-for-return`). `"enabled": false` is the old behaviour. An unknown key or a non-positive window refuses the file. |
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
sit with the crumbs), Snooze, Direction and Dismiss. Every kind gets Dismiss, including a secret and a card pointer. A secret and a card pointer are answered in
their own thread, so they get the thread link, Snooze and Dismiss, and never Direction: dismissing them stops tracking the item and never enters a secret or answers the card.

- **Snooze** offers 1 hour, later today, tomorrow morning, next week and a time of your own, as T3's thread snooze does. The page works each out in the browser's own
  time zone and sends an absolute time (within a year). A snoozed question leaves the active list for the **Snoozed** tab (beside Waiting in the Decisions view, with a count), with when each
  one returns and two pill buttons, Bring back now and Dismiss (the full page keeps a collapsed Snoozed section with Un-snooze), and it comes back by itself at that time, even if Chamberlain was restarted in between. An urgent question is shown again in the Decisions thread when
  it returns (the daemon does that on its once-a-minute tick; a question with `"urgent": false` returns silently). It is not answered, so its afk hold stays open, with a note of the return time.
- **Direction** sends the note box's text and picks no option. It counts as an answer: the Steward gets a `[chamberlain] answer:` wake that says "direction, no option chosen" and carries
  the note, the question leaves the queue and its hold closes. It always goes to the Steward, never straight to the thread. The note is required.
- **Dismiss** ("already handled / no longer needed") asks first, takes the note box's text if there is any, closes the question and its hold, and sends the Steward a short wake that says dismissed. It is
  recorded as a dismissal and creates no ruling. A new idea ask checks recent idea dismissals. Every other ask and hold skips dismissals as before.

**Ideas.** A `kind: "idea"` ask requires a recommendation and nonempty `Cost:` and `Evidence:` lines in its context. It appears in the Ideas tab with its own count and is filed without a post, notification or operator digest entry. `urgent: true` is refused. A cap refusal exits 2 and identifies the cap. Use a `Decline` option to record a decline. The idea lookup also recognizes labels starting with Decline, Reject or Drop and the short answers No and Pass. A matching dismissal or decline within `ideas.declineDays` days prevents refiling unless `notSettled` gives a reason. Approved ideas go to the Steward to file as issues, with blocked-by links for any predecessors. Approval of the idea carries no authorization for one-way actions.

Butlers and workers can suggest an idea by prefixing a note with `IDEA:`. The Steward sees it labeled in its own digest and decides whether to file it.

The Decisions view in T3 does these in place with the view key, which may answer, snooze, direct and dismiss a question and nothing else ([SECURITY.md](SECURITY.md)): no page change. The options are a choice list: pick one (the recommended one starts picked), then the answer button under the list, which names it, sends it. Under that, little buttons along the card's bottom edge, one tap each: **Snooze** is one tap for **1 hour** (the default for the view; the full page has the other choices); **Dismiss** is one tap; **Direction** opens a note field in the same card and Send is the next tap. The card then says what happened, or shows the error and keeps its buttons. Un-snooze stays a link to the full page, and a question's optional note on an option answer is written on the full page.

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

**`sweep.preparePr`** tunes the built-in prepare-pr monitor (item sources `check:prepare-pr` and `check:prepare-pr-other`).
It polls no-mistakes / AXI for parked prepare-pr runs on the **same host as the daemon** (v1: MemberHero on Mithrandir), on
**its own timer** (`intervalMinutes`, default 1) — not the two-hourly routine sweep — so the 1m / 15m wake policy can fire.
Do not register `prepare-pr` under `sweep.checks` (reserved built-in names). Code defaults keep both modes **`shadow`**
and `enabled: false` until configured. **Nathan 2026-11-16:** Mithrandir runs both modes **`live`** (no shadow soak).

```json
{
  "sweep": {
    "preparePr": {
      "enabled": true,
      "intervalMinutes": 1,
      "stateDb": "~/.no-mistakes/state.sqlite",
      "repos": [{ "name": "MemberHero", "path": "/home/nbost/dev/MemberHero" }],
      "oneWayMode": "live",
      "otherMode": "live"
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `true` turns the built-in on. |
| `intervalMinutes` | `1` | Minutes between scans; housekeeping asks each minute whether due. |
| `stateDb` | `~/.no-mistakes/state.sqlite` | Read-only no-mistakes state database. |
| `repos` | MemberHero path | Non-empty list of `{ name, path }` targets. |
| `oneWayMode` | `shadow` | Mode for urgent one-way-door findings (`check:prepare-pr`). Mithrandir: `live`. |
| `otherMode` | `shadow` | Mode for other gates + settled-mismatch (`check:prepare-pr-other`). Mithrandir: `live`. |

Each finding is one parked run (`dedupKey` `prepare-pr:<runId>`): repo, branch, run id, short head, **exact gate step**, and
seconds parked. Wake policy (Nathan 2026-11-16):

| Condition | Source | Finding |
| --- | --- | --- |
| `awaiting_approval` on `gate.review.one-way-door` (or any step name containing `one-way-door`) for **> 1m** | `check:prepare-pr` | `[URGENT]` text, `repeatIntervalMs` 1m |
| `awaiting_approval` on other gates for **> 15m** | `check:prepare-pr-other` | plain text, `repeatIntervalMs` 15m |

**Discovery:** running run ids from `state.sqlite` for every checkout sharing the configured path's `upstream_url`
(temp agent checkouts included), plus top-level `bun run no-mistakes axi`, plus open `prepare_pr_links` run ids. Detail from
`axi status --run <id>` (TOON) in the configured repo path. Offline AXI, nonzero exits, unreadable/unknown DB path, or
incomplete parked status fail closed (`evaluation_error`), never a quiet clear. Manual CLI: `chamberlain prepare-pr status`
(optional `--kind one-way|other|all`). When the daemon moves off Mithrandir, add a host runner (ROADMAP 0.2) — v1 has no SSH.

**Thread ↔ run links** (optional): `chamberlain prepare-pr link <threadId> <runId> [--repo MemberHero]` writes a row in
`prepare_pr_links`. While a link is open, the other-mode source also emits `prepare-pr:settled-mismatch:<runId>` if that
thread is settled but the run is still open. Linked run ids are always statused even when discovery would miss them.
`prepare-pr clear` / `prepare-pr links` manage the table.

**`sweep.idleParents`** tunes the built-in `idle-parents` check (item source `check:idle-parents`). It runs on **its own timer**, every
`intervalMinutes` (default 15), not on the two-hourly routine sweep; the daemon's once-a-minute housekeeping asks whether it is due, and
the check keeps its own clock in the database, so the schedule survives a restart. Each run lists the top-level threads on every
configured server that are not a child or subagent thread, not settled, snoozed or archived, have nothing running or open (no card,
background task, running child, or running subagent the adapter reports), and are `idle` or `completed` with their last message finished more than `thresholdMinutes` ago
(default 5; the check runs every `intervalMinutes`, so a thread is reported within `thresholdMinutes` + `intervalMinutes`), whoever started its last turn: a thread that answered the principal's own question and then sat on a half-answer is listed like any other. The Steward's own thread, the decisions thread, the Alert Desk thread and the `exclude` list are never listed. The
Steward gets one wake with a compact list: server, thread id, title, idle minutes and the last message cut to about 300 characters,
with the threads whose last message asks something (`looksLikeAsk`, so "say go and I'll start it" counts) marked `[ASKING]` and
first, and wait-closings ("holding until…", "waiting for…", "I'll adapt once…", "no reply needed while…") marked
`[WAITING: …]` with who or what is awaited. It is the net under a turn-end wake that missed a thread. A thread is reported on
its last message, and **again every `repeatHours` (default 2)** while that same message still idles and the finding is open, so a
multi-hour stall is not silent after the first wake. One digest per pass. It goes quiet when the thread runs, is settled or
snoozed, or the Steward records a hold naming it. When `threads.steward` changes, every open idle finding is re-queued once to
the new Steward. A new message makes a new finding. It calls no model: the selection is plain code (`selectIdleThreads`).

The wake tells the Steward to handle every listed thread, whoever started it: no thread is hands-off because it is the operator's own. When the
next action is clear and inside the decision rights, the Steward moves the thread forward. When a decision is pending, it files that decision
on the operator's queue with `ask`, routed back to the thread when the pick is simple. When the thread is finished, it settles it. It leaves a
thread untouched only when the thread already has an open queue item or a hold, is running, or is a child whose parent is working. The text is
built in (`idleThreadsWake`, `src/core/messages.ts`); it is not a ruling and needs no decision-rights entry.

```json
{ "sweep": { "idleParents": { "enabled": true, "intervalMinutes": 15, "thresholdMinutes": 5, "maxThreads": 10, "repeatHours": 2 } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the check off. |
| `intervalMinutes` | `15` | A positive number of minutes between runs. The housekeeping tick is once a minute, so a run starts within a minute of when it is due. |
| `thresholdMinutes` | `5` | A positive number of minutes a thread must have been idle. The default was 30 before the Steward was told to move every idle thread forward; raise it to make the check quieter. |
| `maxThreads` | `10` | The most NEW threads one wake lists, asks first, then the longest idle; the rest are listed on a later run. A thread already reported never counts as new. |
| `repeatHours` | `2` | Hours between re-notifies of the same still-open idle finding (same last-message key). |

A key it does not know is refused. A configured check cannot be named `idle-parents`. The check reads each candidate thread's last
message, so it needs an adapter whose `inspect` has `lastAssistant` (the T3 adapter does); without it the check lists nothing.

**`sweep.undelivered`** tunes the built-in undelivered-message check (item source `check:undelivered-message`). On every watched
server, it looks for a top-level idle/completed thread whose latest completed run finished in under `maxDurationSeconds`
(default 10), has `executedModel` null, and whose last chat item is a user or agent message with no assistant reply after it
(the 2026-11-15 Pilot B shape: message delivered, model never ran). It wakes the Steward promptly to resend. Default interval
is 1 minute.

```json
{ "sweep": { "undelivered": { "enabled": true, "intervalMinutes": 1, "maxDurationSeconds": 10 } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the check off. |
| `intervalMinutes` | `1` | Minutes between scans. |
| `maxDurationSeconds` | `10` | A completed run shorter than this may be undelivered when `executedModel` is null and there is no assistant reply. |

A configured check cannot be named `undelivered-message`. The check needs `inspect.latestRun` (the T3 adapter provides it).

### Overhead monitor

**`overhead`** measures what the Steward (and Chamberlain's own model calls) cost against the work that got done, and can open one
investigator thread when a limit is crossed. Everything about it is configuration: **nothing is built in** about a person, a repository, a
model, a price or a vendor. With no `overhead` section it is off; `chamberlain overhead` still measures what it can (the Steward's no-op wake
rate, from the database) and says "not configured" for the rest. It needs `stewardTokens` on, because the usage rows are its input
([`steward-health.md`](steward-health.md#tokens-per-wake)).

What is measured, over a rolling window (default 24 h):

- **Cost per merged PR** = Steward spend + Chamberlain's classifier spend, divided by the PRs merged in the window. Merged PRs are the proxy for
  work done, for now. Zero PRs never divides: the number is shown as "no PR merged", and `zeroPrFloorUsd` says what spend then crosses.
- **No-op wake rate** = wakes that made no tool call / wakes measured with tool counts. Not judged on fewer than `minWakes` wakes.
- **Chamberlain-caused spend** = the Steward's tokens, Chamberlain's own model calls, and what the **butlers and investigators it launched** spent.
  Those threads are named by **Chamberlain's own launch records** (the butler ledger and the investigations in its state), never by a project or a
  title, which any other session could share: LifeOS gives the spend of the sessions that ran for those thread ids
  (`metadata->>'t3_thread_id'`). A launched thread with no session is said so and adds nothing (its spend is unknown, not $0); if the read
  fails the caused spend is unavailable.
- **Overhead share** (the headline) = Chamberlain-caused spend / the whole fleet's Claude spend, over the window. **Experiments are in neither side** (`excludeProjects`, `excludeLabels`).
  The **Steward-only share**, the Steward's own spend / the same fleet spend, is shown beside it. Its key is `triggers.spendShare`.
- **Managed overhead ratio** = Chamberlain-caused spend (the numerator of the overhead share) / the spend of the T3 threads Chamberlain
  **supervised** in the window, experiments excluded. Also shown: the count of managed threads, the cost per managed thread (caused spend /
  count) and the **coverage**. A thread is managed when Chamberlain took action on it in the window, which its own database records twice: a
  `fire` event of the event log (the watcher woke the Steward about it; the event carries the server, so the host) and a wake or report queued
  for the Steward naming it (`outbox_members` and `held_wakes`; the notes builders send). The threads Chamberlain runs itself are not managed:
  the pinned Steward, Decisions and Desk threads, the butlers it launched and its investigators. The spend comes from LifeOS: a Claude session's
  `metadata->>'t3_thread_id'` names the T3 thread it ran for, and `otel_api_requests` its cost. A managed thread with at least one such session
  is **mapped**; one with none is **unmapped**, and its spend is unknown, **never $0**. **Coverage** = mapped / managed, shown by host. Below
  100% the ratio is **PARTIAL** (its denominator is short, so it overstates) and is only ever reported: a trigger judges it only at **full**
  coverage (no unmapped thread) and only while every host in `fleet.hosts` has rows, as for the spend share. `minCoverage` is the bar the
  report flags, not a licence to trigger on a partial ratio. Needs `fleet.source` `"lifeos"`.
- **Cost per useful wake** = Steward spend / wakes that made at least one tool call. Reported only.

Each number is one of three things, and says which: a value, **not configured** (you have not asked for it) or **unavailable** (you asked, and the
read failed: GitHub down, no price for the Steward's model, the fleet database unreachable). A gap is never filled with a guess or a zero, and
a number that is not available crosses no limit. The numbers appear in `chamberlain overhead`, in the Decisions view (the Steward health
panel) and in the brief the investigator is given.

```json
{
  "overhead": {
    "enabled": true,
    "github": { "owners": ["my-org"], "repos": ["someone/else"], "excludeRepos": ["my-org/docs"] },
    "prices": { "<the model models.steward names>": { "input": 0, "cacheWrite5m": 0, "cacheWrite1h": 0, "cacheRead": 0, "output": 0 } },
    "triggers": {
      "costPerPr": { "mode": "trigger", "baselineMultiplier": 1.5, "zeroPrFloorUsd": 5 },
      "noopRate": { "mode": "trigger", "threshold": 0.1 }
    },
    "investigator": {
      "enabled": true,
      "model": { "adapter": "t3", "server": "main", "instanceId": "<provider instance>", "model": "<model>", "options": { "effort": "high" } },
      "projectId": "<T3 project id>"
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | The daemon measures every `checkEveryHours` and may open an investigator. `false`: the daemon does neither; `chamberlain overhead` works regardless. |
| `windowHours` | `24` | The rolling window every number covers. |
| `baselineDays` | `7` | The length of the baseline: the cost per PR over this many days **before** the window, which a `baselineMultiplier` limit is measured against, and of the trailing figure shown beside the window's. |
| `checkEveryHours` | `24` | How often the daemon measures. A restart does not measure early. |
| `github.owners` | none | Owners (a user or an organization) whose merged PRs count. |
| `github.repos` | none | Individual `owner/name` repositories to count, in addition. With no owner and no repo the per-PR number is "not configured": it is reported and never triggers. |
| `github.excludeRepos` | none | `owner/name` repositories left out of the count. |
| `github.countRollups` | `false` | A bors rollup PR bundles PRs that GitHub marks merged on their own, so by default the rollup is not counted: its members are, once each. `true` counts the rollup too. |
| `github.rollupTitle` | `^Rollup of \d+ pull requests?` | The pattern (case-insensitive) that marks a PR as a rollup. |
| `prices` | none | USD **per million tokens**, per model: `input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`, all required, each zero or more. Chamberlain ships no rates; copy the ones you pay from your vendor's price list and keep them current. The Steward's model is the one `models.steward` names, and is looked up here. |
| `cacheWrite` | `"1h"` | Which cache-write rate the usage rows are priced at, `"5m"` or `"1h"` (the rows do not say which TTL wrote them). Check it once against your provider's billing. |
| `excludeProjects` | none | Session projects that are experiments, not work (an eval project, say): their spend is in **neither** the fleet total **nor** any Chamberlain-caused figure, and is shown apart as "EXCLUDED experiments". The numerator is cleaned the same way: a Steward usage row read from an excluded session, and a classifier call on a thread an excluded session ran for, count as nothing. If an exclusion is set and cannot be applied (`fleet.source` is `"off"`, LifeOS cannot be read, or an id cannot be looked up), the Steward and classifier spend and the no-op rate are unavailable (never a figure that may contain experiments) and nothing triggers. Launched butlers and investigators count in the managed coverage: one with no LifeOS session makes the caused spend, the spend share and the managed ratio unavailable (none triggers). When an exclusion cannot be applied, the classifier figure is unavailable too, with every other money figure. Empty by default; nothing is excluded unless you say so. |
| `excludeLabels` | none | The same, for sessions that carry any of these labels (what a runner such as an eval harness stamps on the sessions it launches). A request with no session row cannot be told to be an experiment, so it stays in the total. |
| `fleet.source` | `"off"` | Where the whole fleet's spend comes from, for the overhead share: `"off"` (no share), or `"lifeos"`: a read-only `SELECT` through the LifeOS query tool over its `otel_api_requests` and `sessions` tables. |
| `fleet.command` | `"lifeos-axi"` | The query command for source `"lifeos"`; it is run as `<command> query --sql <SELECT>`. |
| `fleet.hosts` | none | Hosts the fleet total should include. One with no rows in the window is named in the report. |
| `triggers.costPerPr` | `mode: "report"` | `mode` is `"report"` (shown only) or `"trigger"`. Crosses when the window's cost per PR is above `fixedUsd`, or above `baselineMultiplier` x the baseline's cost per PR (whichever are given; the lower applies). `zeroPrFloorUsd`: with no PR merged, spend above it crosses. A trigger needs at least one of the three, and `github.owners` or `github.repos`. |
| `triggers.noopRate` | `mode: "report"`, `minWakes: 20` | Crosses when the share of wakes with no tool call is above `threshold` (above 0, up to 1; `0.1` is 10%), on at least `minWakes` measured wakes. |
| `triggers.managedRatio` | `mode: "report"`, `minCoverage: 0.9` | Judges the managed overhead ratio. `"trigger"` needs a `threshold` (above 0) and `fleet.source` `"lifeos"`, and crosses when the ratio is above it **and** every managed thread is mapped (full coverage) **and** every host in `fleet.hosts` reported; a partial ratio never crosses, at exactly `minCoverage` or above it, whatever `mode` says. `minCoverage` (above 0, up to 1) stays as the reporting bar. `"report"` with a `threshold` shows it as a target. |
| `triggers.spendShare` | `mode: "report"` | Judges the headline overhead share. `"trigger"`: crosses above `threshold`, and needs `fleet.source` other than `"off"`. `"report"` with a `threshold`: the threshold is shown as the target ("target at most 20.0%") and nothing opens. |
| `investigator.enabled` | `false` | Open an investigator thread on a crossing. Needs `model` and `projectId`. |
| `investigator.model` | none | The provider, model and effort of the thread: a T3 selection, `{ adapter, server, instanceId, model, options }`, the same shape `models.<role>` takes and checked the same way against the server's catalog before anything starts (no default, no fallback to another provider). |
| `investigator.projectId` | none | The T3 project the thread is created in. |
| `investigator.title` | `"Overhead investigation"` | The thread's title starts with this. Its own spend is found by the thread id Chamberlain recorded for it, not by the title, and shown as its own line. |
| `investigator.cooldownHours` | `24` | One investigation per this long, counted from the later of when the last one was **reserved** and its last launch call (a retry restarts it), a launch with an unknown outcome included. A **pending** reservation (launch outcome unknown) blocks any new one whatever `maxOpen` is, and at most **one launch call** is made per tick, a retry and a new reservation together; a retry reuses its reservation's key and never makes another. The launch time is kept in Chamberlain's own state, and across restarts the cooldown is the wall-clock time since that stored time, with no credit for a restart. If the clock reads earlier than the stored launch, the cooldown is not over. Inside the process that made the reservation the monotonic clock is read too and the larger of the two is taken, unless either is below zero. A real forward jump of the wall clock cannot be told apart from time passing, so it ends a cooldown early: accepted. |
| `investigator.maxOpen` | `1` | Investigations that may be held at once, held meaning pending or open. One is released when the investigator runs `chamberlain overhead close <id>`, or when `ttlHours` has passed **and** T3 shows its thread idle, archived or gone. |
| `investigator.ttlHours` | `72` | After this long an investigation is **stale**: reported in the numbers, and still held. The clock alone never frees a slot, so a thread that is still working cannot be joined by a second investigator. |
| `investigator.instructions` | none | Your own rules for the investigator (workspace conventions, where to report), appended to its brief. |

The investigator's brief carries what crossed, the numbers and their trend, the no-op wakes grouped by kind with example delivery ids, and the
dearest turns. It asks for the cause in code (file and line) and a draft fix PR, never a deploy, and a report to the Steward with
`chamberlain note`. The launch is reserved in the state as `pending`, with its brief, before any command goes out, and every id it sends comes from
that reservation, so repeating it is safe. A reservation leaves `pending` **only** when T3 positively shows a thread with its brief (it opens) or
positively shows no thread at all (and the launch was refused or the investigator is disabled: it closes). A refused preflight, an error, a lost
response or an inspection that cannot be had releases nothing, so a retry that is refused while T3 already made the thread cannot free the slot
for a second one. The daemon, after a restart too, asks T3 what the reservation became and either opens it or repeats the same launch. An
outcome nobody knows counts as launched. With `investigator.enabled` false, reconciliation only observes and closes: it never sends a launch or
a brief. With no investigator configured at all, a crossing is recorded in the numbers and nothing is reserved. The record keeps every held
reservation and only the newest 20 closed ones. The investigator's own spend is a separate line and is kept out of the cost the trigger divides,
so an investigation cannot cause the next one. A failed GitHub or fleet read is shown as a fixed class (`unavailable (http-4xx)`), never as the
tool's own text, because that text can echo a credential and the line reaches the investigator. A baseline period with no usage rows is
unavailable, never a $0 baseline; a configured fleet host with no rows makes the spend share unavailable; a value that is not a finite number
crosses nothing. A bad value is refused with its key named, at `chamberlain config show` and at every daemon start: a negative or zero limit, an
unknown key, a trigger with no limit, a missing price for the Steward's model while `enabled`, an empty price table while `enabled` with PRs
counted.

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
        "jev": { "model": "your-explicit-jev-model", "keyFile": "typesafe.key", "timeoutMs": 10000 }
      }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `none` | `none` (off), `rules` (local regular expressions), `jev` (TypeSafe's probability-head API), or `model` (the explicit isolated reader in `models.classifier`). Legacy `haiku` must be migrated. |
| `mode` | `shadow` | `shadow`: classify and record, report as without the classifier. `live`: report only escalate, nudge and unknown, tagged. |
| `allowTextToLeaveMachine` | `false` | Must be `true` for `jev` or `model`, which send thread text off the machine; either without it is refused at load. |
| `questions` | `default` | `default` (the evaluated bank, `src/core/classifier/questions.default.json`) or the path of a bank file, relative to this directory. |
| `thresholds` | `{ "default": 0.5 }` | The probability at or over which a question counts as yes: `default`, and per question id. A threshold for an id the bank does not have is refused. |
| `send` | `1500`, `400`, `true` | `lastChars` of the last message, `previousChars` of the user message before it, and whether the thread title (at most 200 characters) goes. Every cut is made well-formed Unicode. |
| `redact` | `true`, `null` | `builtin`: replace emails, API-key and token shapes, JWTs, phone numbers and home-directory user names, found in the whole message so a long token that starts before the cut is still caught. `command`: `["program", "arg", …]`, given the state as JSON on stdin; it must print the same shape within 5 seconds, or nothing is sent and the thread is `unknown`. |
| `budget` | `20`, `500`, `0.25` | `maxPerRun`: the most classifications one run makes (the rest are `unknown` this run, classified on a later one). `maxCallsPerDay` and `maxUsdPerDay`: for `jev` and `model`, every attempt in the UTC day counts, a retry of a failed call included, and so does the cost a failed but billed call reports (counted in the database as each call is made, and never less than the disposition table's own sum); when either is spent, unclassified threads are `unknown` until the next UTC day. Up to three calls already under way can finish past the dollar ceiling. |
| `armedGraceMinutes` | `360` | How long a thread's claim that a watch or timer will wake it is believed. An idle parent has no running background task, so a claim older than this has lost its wait. |
| `jev` | see above | `model` (pinned; the model the API reports is recorded, and a reported id that is not a short token is refused, so no echoed text is stored), `keyFile` (a file name in `secrets/`, mode 0600, read by the daemon at each call and never logged), `timeoutMs`. |
| `haiku` | none | Legacy migration input only: explicit `command`, `model`, `timeoutMs` move into `models.classifier`. The retired runtime provider is rejected until migrated. |

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
reading model (a configured `models.mailDriver`, `models.mailEscalate` or `models.mailTop`) **and** `allowMailToLeaveMachine: true`; without the second startup is refused.

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
| `models` | none | Legacy input only: migrate explicit settings with `chamberlain config migrate`. Live selections belong in top-level `models.mailDriver`, `models.mailEscalate` and `models.mailTop`; absent means no model. |
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
  chamberlain.db              the SQLite ledger database (mode 0600), with chamberlain.db-wal and -shm beside it while it is open
  obs.db                      the telemetry database (mode 0600, WAL): events, and the logger's counters. Safe to delete with the daemon stopped (the reconciler rebuilds the
                              ledger-derived events at the next start); a backup of the ledger does not need it
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
| `CHAMBERLAIN_VERBOSE` | unset | Also print each log line to stdout, as the old `events` table holds it. |
| `CHAMBERLAIN_LOG` | unset | `debug`: also store `debug` rows in `obs.db` (otherwise a `debug` call is dropped). |
| `CHAMBERLAIN_HOST` | the hostname | The `host` column of every row this process writes: lowercase letters, digits and dashes, 32 at most. |
| `CHAMBERLAIN_ALARM_KEY` | set by Chamberlain | Not for you to set. It is in the environment of your `alertCmd` when Chamberlain runs it: the alarm's stable key (for example `steward-stalled`), so a command that pages someone can de-duplicate on it. |
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
| `chamberlain overhead [--json]`, `overhead close <id> [--note "<text>"]`, `overhead investigations` | you, the investigator | Measure now and print the overhead numbers, what crossed, what is not configured and what could not be read ([Overhead monitor](#overhead-monitor)); changes nothing and opens no investigation. `close` ends an investigation (the investigator runs it when done); `investigations` lists them. |
| `chamberlain config migrate\|revert [--dry-run]`, `config show`, `config get <key>` | you | `migrate` MOVES the old file-per-setting layout into `config.json` and `secrets/`; `revert` puts it back so an older build starts; `--dry-run` prints what it would do. `show` prints every key with where its value comes from, every secret by name, and flags any old file written again after the move. `get <key>` prints one value for a script (`threads.steward`, `web.port`), never a secret. See [config-migration.md](config-migration.md). |
| `chamberlain migrate [--check]` | you | Check every old-layout config file's schema version and upgrade old ones. (The database migrates itself when opened.) |
| `chamberlain mail [status]` | you | The optional email triage module: says it is off, or prints what is in force and makes `mail.db`. Reads and changes no mailbox yet. |
| `chamberlain switch-steward <threadId>` | the Steward | The last step of a hand-off: make this thread the wake target. |
| `chamberlain debug <command>` | you | Diagnostic commands, listed by `chamberlain debug help`: `peek <server> <threadId>` (the end of a thread in plain lines, a tenth of what `t3_thread_read` costs), `t3x threads\|read\|respond\|send <server>` (act on a thread on any configured server), `queue-waits [--hours N] [--store FILE]` (how long wakes sat before the Steward started on them), `compat [origin]` (a T3 server's version and whether it is in the tested range), `synthetic-wake` (queue one wake shaped like the daemon's, as an outbox row, so the running daemon sends it and the whole path is proved), `desk-allowlist hook\|check '<command>'` (the Alert Desk's command allowlist). The old top-level names (`chamberlain peek`, and so on) still work. |
