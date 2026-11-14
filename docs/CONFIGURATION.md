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
| `web-token` | the page: made on its first start | The page's capability token: 32 random bytes. Every request to the page must hold it. `chamberlain web link` prints the links that carry it, `chamberlain web rotate-token` replaces it. See [web-access.md](web-access.md). |
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
| `mayBeOffline` | A laptop that sleeps: no alarm when its socket stays down. |
| `sshHost` | `user@host` reachable by key-based ssh, so `git` can be asked about a worktree path on that machine. |

**`web`** (the page refuses to start without it):

| Key | Meaning |
| --- | --- |
| `host` | **Required.** The one address to bind: `127.0.0.1`, `::1`, an address in Tailscale's `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. Any other address, any host name and every wildcard is refused. |
| `port` | Default `3790`. |
| `allowedHosts` | Extra `Host` header names to accept, such as the machine's MagicDNS name. |
| `threadLinks` | Server name to the T3 web URL prefix a thread id is appended to, for "Open thread" links. |
| `mirrorLinks` | Server name to the link base used for mirrored cards (`t3-thread://v2/<environmentId>/`). |
| `decisionsServer` | `{ "origin": "...", "operateTokenFile": "..." }` (the token file is in `secrets/`): the T3 server hosting the Decisions thread, with an `orchestration:operate` token. Enables the "Decisions · N waiting" title and settling cards. |
| `answerTokens` | Server name to an operate-token file in `secrets/`: cards on that server become answerable from the page. Without one a server is read-only. |
| `publicBase` | An `https://` base (for example from `tailscale serve`) used in inline views when T3 is loaded over https. |

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
turns of their own (a runaway), with no configuration, and one built-in check, `idle-parents`, described next. Any future monitor plugs in the same way, as another source
([`ARCHITECTURE.md`](ARCHITECTURE.md#the-item-system)).

**`sweep.idleParents`** tunes the built-in `idle-parents` check (item source `check:idle-parents`). Every routine sweep it lists the
top-level threads on every configured server that are not a child or subagent thread, not settled, snoozed or archived, have
nothing running or open (no card, background task or running child), and are `idle` or `completed` with their last message
finished more than `thresholdMinutes` ago. The Steward's own thread, the decisions thread, the Alert Desk thread and the
`exclude` list are never listed. The Steward gets one wake with a compact list: server, thread id, title, idle minutes and the
last message cut to about 300 characters, with the threads whose last message asks something (`looksLikeAsk`, so "say go and
I'll start it" counts) marked `[ASKING]` and first. It is the net under a turn-end wake that missed a thread. A thread is
reported once per last message (the item's key is the thread plus a hash of that message); a new message makes a new report.

```json
{ "sweep": { "idleParents": { "enabled": true, "thresholdMinutes": 60, "maxThreads": 10 } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the check off. |
| `thresholdMinutes` | `60` | A positive number of minutes a thread must have been idle. |
| `maxThreads` | `10` | The most NEW threads one wake lists, asks first, then the longest idle; the rest are listed on a later sweep. A thread already reported never counts again. |

A key it does not know is refused. A configured check cannot be named `idle-parents`. The check reads each candidate thread's last
message, so it needs an adapter whose `inspect` has `lastAssistant` (the T3 adapter does); without it the check lists nothing.

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
| `chamberlain web link`, `web rotate-token` | you | `link` prints the page's links with the key on them (one to open on a phone or laptop, one for the Decisions thread's setup message). `rotate-token` makes a new key: every old link, cookie and rendered view stops working at once, and the new links are printed. |
| `chamberlain ask '<json>'` | the Steward | Put one question on the queue and in the Decisions thread (the view it posts carries the page's key). `proposedRuling` is the ruling you may save with your answer; add `proposedExpires` (a date or a date-time with a zone) when it is about one run, launch or week, and the saved ruling expires by itself. `"urgent": false` lists it below the urgent ones and posts nothing. A question already settled (an answer, a ruling, a logged decision) is refused with exit 2 and what it matched on; `"notSettled": "<why>"` overrides it. |
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
| `chamberlain switch-steward <threadId>` | the Steward | The last step of a hand-off: make this thread the wake target. |
| `chamberlain debug <command>` | you | Diagnostic commands, listed by `chamberlain debug help`: `peek <server> <threadId>` (the end of a thread in plain lines, a tenth of what `t3_thread_read` costs), `t3x threads\|read\|respond\|send <server>` (act on a thread on any configured server), `queue-waits [--hours N] [--store FILE]` (how long wakes sat before the Steward started on them), `compat [origin]` (a T3 server's version and whether it is in the tested range), `synthetic-wake` (queue one wake shaped like the daemon's, as an outbox row, so the running daemon sends it and the whole path is proved), `desk-allowlist hook\|check '<command>'` (the Alert Desk's command allowlist). The old top-level names (`chamberlain peek`, and so on) still work. |
