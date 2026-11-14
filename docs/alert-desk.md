# The Alert Desk

Alerts get their own standing thread, the **desk**, instead of a Steward wake kind. Alert sources append one JSON line each to an inbox file; the
daemon drains it (`src/core/alert-desk.ts`), dedupes per alert family through the item system, and queues wakes for the `desk` receiver. The daemon's
one relay sends them, as a second receiver (`receivers: { desk }`), through the adapter's `alertDesk` capability and the relay's one serial POST
queue, with the desk thread's own busy gate, so
the hold-and-digest path folds a burst of families into one wake and a busy desk never holds the Steward's wakes. The desk's standing prompt is
`docs/alert-desk-prompt.md`, a template: `chamberlain brief desk` prints it filled in from your config (`principalName`, the Steward's
own server in `servers.json`, this checkout, and the morning sources below).

```
alert sources ──> ~/.cache/alert-desk/inbox.jsonl ──> drainAlertDesk (items decide) ──> outbox (receiver desk) ──> the relay (desk lane) ──> desk thread
 (any process,       one JSON line,                    window, 24 h repeat, cap          held while the desk is busy
  one O_APPEND write) {v,source,family,title,body,ts,severity}                             and sent as one digest
```

## The inbox line

```json
{"v":1,"source":"monitor-webhook","family":"HostUnitFailed|scope=system,unit=a.service","title":"a.service failed","body":"...","ts":"2026-11-13T15:00:00.000Z","severity":"warning"}
```

One object per line, written with a single `write` on a file opened with `O_APPEND`, so writers never interleave and a reader never sees half a line.
`severity` is `critical`, `warning` or `info`. The family key must be stable for one condition and distinct between conditions.

## What decides, and where

Every decision is the item system's (`src/core/notification.ts`); there is no second record of what already woke the desk. For each family:

| Case | How the items express it |
| --- | --- |
| First event | no open `alert` item: queue the wake, `observe` the item (reason `new`) |
| Further events inside 15 minutes | the family's `window` item does not notify: absorbed and counted, and a *change* is parked as a `pending` item (mode `silenced`) |
| A change after the window | resolve the `alert` item, `observe` it again: a new occurrence notifies (reason `changed`) |
| Unchanged, inside 24 h | the `alert` item's repeat policy does not notify: folded |
| 24 h after the last wake | the `alert` item's repeat policy notifies (reason `repeat`) |
| Over `dailyCap` alert wakes in 24 h | parked as `pending`; the desk is told once a day (`cap-note` item); it goes as older wakes leave the window |

A change is a different severity, title or the first 300 characters of the body, with timestamps and numbers blanked (`signature`). Events older
than `maxAgeHours` (6) when read are not woken about. A cursor (inode and offset) in the `state` table keeps what was read; a replay after a crash is
absorbed because the items already hold what woke the desk. A big, fully read inbox is renamed away and its retired file read once more a minute
later, for a writer that still held it.

**The first start.** With no cursor stored (the desk's first run, or its first run after an import that does not carry an
older system's desk state over), `startAt` in `alert-desk.json` decides where reading begins. `"end"`, the default, sets the cursor to the
inbox's current end, so nothing already in the inbox wakes the desk (a line being written at that moment is skipped whole); with no inbox yet,
the cursor starts at its beginning, so the first lines written to it are read. `"beginning"` reads the whole existing inbox (events older than
`maxAgeHours` still wake nobody). The cursor is saved before anything is read and the choice is logged once, as `alert-desk-start` with
`startAt`, the inbox, the offset and, for `"end"`, the bytes skipped. A stored cursor is never moved by `startAt`.

**Removing the desk.** With no `desk-wake-url` the desk's lane stays and its waiting wakes raise `desk:wake-not-ready`. If the receiver
itself is gone (the home server in `servers.json` is now one whose adapter has no `alertDesk`), desk wakes still waiting are kept, never
dropped or sent to the Steward: the relay raises `desk:wake-unconfigured` naming the receiver and the count, and `chamberlain wakes list`
shows each row with `for desk`, so `chamberlain wakes cancel <id>` can give it up.

## Delivery guarantee

At-least-once, with stable ids. A wake's id comes from the event (`desk:<hash of family, signature and time>`), a replay after a crash makes the same id, and
an id already bound to an outbox row (any status) or tombstoned is never enqueued again. One window cannot be closed: a crash after the webhook accepts a
POST and before the row is committed `delivered` sends that wake once more after the restart (`src/core/relay.ts` describes it), under the same id. So the
desk skips an id it has already handled: its prompt says to search the thread for the id first and answer `repeat of <id>` (docs/alert-desk-prompt.md).

## The command allowlist is enforced

`chamberlain debug desk-allowlist hook` (`src/desk-allowlist.ts`) is a Claude Code PreToolUse hook that DENIES BY DEFAULT. It allows only: Bash in a fixed set of command shapes (journalctl,
systemctl status, read-only gh and git commands, docker ps/logs/inspect with a plain `--format`, your own `commandShapes`, and the Morning sweep's own commands);
Read, Grep and Glob under `/var/log`, `~/.cache/alert-desk` and `DESK_LOG_DIRS` (never a credential path, after `..` and symlinks are resolved); and the
Agent tool only to start the `gatherer` agent you name in `alert-desk.json`, which is how the desk fans out (with none named, no agent starts). Every other tool is refused: the write tools, every MCP tool, and any
name it does not know. A command's whole argument list is parsed: a flag that is not on that command's list is refused, a flag given twice in any
spelling (`--format` then `-f`) is refused, and every value is checked. `chamberlain debug desk-allowlist check '<command>'` tests one by hand.

The matcher must cover every tool, or the default deny never sees the tool it is meant to refuse. Install it in the desk project's `.claude/settings.json`
(`"*"` matches all tools, MCP tools included):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "chamberlain debug desk-allowlist hook" } ] } ] } }
```

From a checkout the hook command is `bun <the checkout>/src/desk-allowlist.ts hook`. `chamberlain desk-allowlist hook`, the name before the
commands were grouped, still works, so a hook installed earlier keeps running.

Filing a decision is allowed in one spelling only, `<ask command> '<json>'`, matched as the whole string. The ask command is `bun $DESK_ASK_PATH` when
`DESK_ASK_PATH` is set in the hook's environment, else this build's own: `chamberlain ask` from the standalone binary, `bun <that checkout>/src/ask.ts` from source.
`chamberlain brief desk` (from a checkout, `bun src/brief.ts desk`) fills the standing prompt with the same command (`{{askCommand}}`), so set
`DESK_ASK_PATH` for both or for neither. Each configured morning command is matched exactly as written (a `<N>` slot is a number), with nothing
trimmed: a leading or trailing space, tab, newline, no-break space or byte-order mark is refused.

## Nothing changes until the desk is switched on

The desk is off until the adapter has a `desk-wake-url` (the drain reads nothing without it). The alert writers (your monitors' webhooks and heartbeats)
append only when the desk is on: `ALERT_DESK_ENABLED=1` in their environment, or the flag file `~/.config/alert-desk/enabled` (`touch` it; remove it to
switch them off; no restart is needed).

## Upgrading from a build that had a fixed command set

Two things changed on purpose, and a desk that relied on either needs one line of config to behave as before:

- **The morning hour is read in the machine's own time zone** unless `timezone` is set. To keep a zone, set it: `"timezone": "<an IANA zone>"`.
- **No gatherer agent and no extra command shapes are built in.** The desk starts no agent, and only runs journalctl, systemctl, docker and
  read-only `gh` and `git`, until you name them. To keep a wrapper tool or a gatherer agent you used before, add `"gatherer": "<agent name>"`
  and a `commandShapes` entry for each command (the fields are below); a wrapper whose shape matches `gh` or `git` takes the same shape under its own name.

## Switching it on

1. Create the desk thread with the output of `chamberlain brief desk` as its first message, install the allowlist hook in its project, bind a
   webhook scheduled task to it, and save its URL as `desk-wake-url` (0600) and its thread id as `desk-thread` in the config directory.
2. Write `alert-desk.json` (below) if you want a time zone, morning sources, extra command shapes or a gatherer agent.
3. `touch ~/.config/alert-desk/enabled` to switch the writers on.

The alert-desk tables arrived with database migration 8, which an older build cannot open (a database from a newer build is refused);
back the database up first if you may go back ([CONFIGURATION.md](CONFIGURATION.md#state-directory-localstatechamberlain-chamberlain_state)).

## Config

`$CHAMBERLAIN_CONF/alert-desk.json` (all optional) and the environment:

```json
{ "windowMinutes": 15, "repeatHours": 24, "dailyCap": 30, "morningHour": 7, "timezone": "Europe/London", "maxAgeHours": 6, "enabled": true, "startAt": "end",
  "morningCommands": ["bun /opt/monitor/report.ts list --limit <N> --json"], "morningNotes": "Skip the monitor's own heartbeat events.",
  "gatherer": "evidence-reader",
  "commandShapes": { "opsctl": { "bare": true, "subcommands": { "health": { "positional": "word", "max": 1 }, "journal": { "flags": { "--limit": "digits" }, "positional": "word", "min": 1, "max": 1 } } } } }
```

`timezone` is the zone `morningHour` is read in; unset, it is the machine's own zone.

`morningCommands` are the sources the Morning sweep reads that the inbox does not carry, each run exactly as written (`<N>` is a number the
desk fills in, 1 to 12 digits; `<N:1-5>` gives the slot its own width, here 1 to 5 digits, and `<N:10>` exactly 10, any width within 1 to
12; a command with a malformed slot, such as `<N:0-3>` or `<N:5-2>`, is left out with a warning), and `morningNotes` says how to read them. Both go into the prompt (`chamberlain brief desk`), and `src/desk-allowlist.ts` allows
exactly these commands, so they widen what the desk may run: they are read only when `alert-desk.json` is owned by you and no group or other
user can write it (0600 or 0644). Nothing of the kind is built in; with none configured, the Morning sweep reports only what its wake carries.

**`commandShapes`** add read commands only your install has (a wrapper around a CLI, say) to what the desk may run. Each key is a bare command name; a
shape lists what the command may take, and nothing else is accepted:

| Field | Meaning |
| --- | --- |
| `subcommands` | `{ "<one or two words>": <body> }`: the command must start with one of them, and the rest is checked against that body |
| `bare` | `true` allows the command with no argument at all (with `subcommands`) |
| `flags` | `{ "--flag": "bool" \| <kind> }`: the flags allowed, each `bool` or taking one value of that kind |
| `same` | `{ "--long": "-s" }`: two spellings of one flag, which may be given once between them |
| `positional` | a kind, or a list of the literal words allowed |
| `min`, `max` | how many positional arguments (a shape with none takes none) |
| `paths` | `true` lets `--` end the flags, followed by relative paths inside the checkout |

A **kind** is one of `digits`, `word`, `unit` (a systemd unit name), `time`, `repo` (`owner/name`), `ref` (a git ref): each a fixed pattern, never free text. A
flag given twice, in any spelling, is refused, and so is any flag or argument the shape does not list. The generic shapes that ship are `gh` (`run view`, `run list`,
`pr checks`) and `git` (`status`, `log`, `diff`), written in this same format (`src/core/desk-shapes.ts`); `journalctl`, `systemctl` and `docker` are code,
and none of the five can be redefined. A malformed shape is left out whole, with a warning.

**`gatherer`** is the name of an agent the desk may start to read evidence (the Agent tool, `subagent_type: <name>`, with only a prompt, a description and
`run_in_background`; any other field is refused, so it cannot be widened into a checkout, another model or a remote run). The standing prompt names it, and
the gatherer is under the same hook as the desk. Unset, the desk reads the evidence itself and the Agent tool is refused.

`commandShapes` and `gatherer` widen what the desk may run, so, like `morningCommands`, they are read only when `alert-desk.json` is owned by you and no
group or other user can write it.

`ALERT_DESK_INBOX` overrides the inbox path. The T3 adapter needs a private `desk-wake-url` (a webhook bound to the desk thread) and, for its busy
gate, `desk-thread`; without the URL the desk is off and the inbox is not read. The first pass of each local day from `morningHour` sends the
morning wake, which runs the Morning sweep in the desk's prompt over the `morningCommands`.

## Schema

Migration 8 adds a nullable `receiver` column to `outbox` and `held_wakes` (NULL is the Steward, as every row so far) and freezes it with the row.
`store.wakes.held(lane)` and `rows(status, lane)` read one receiver's wakes (`null`: the Steward's, a name: that receiver's, nothing: all of them);
`compose` takes one receiver's held wakes only. The relay passes `null` for the Steward's lane and `"desk"` for the desk's.
