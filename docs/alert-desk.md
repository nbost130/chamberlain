# The Alert Desk

Alerts get their own standing thread, the **desk**, instead of a Steward wake kind. Alert sources append one JSON line each to an inbox file; the
daemon drains it (`src/core/alert-desk.ts`), dedupes per alert family through the item system, and queues wakes for the `desk` receiver. A second
relay (the same `createRelay`, `receiver: "desk"`) sends them through the adapter's `alertDesk` capability, with the desk thread's own busy gate, so
the hold-and-digest path folds a burst of families into one wake and a busy desk never holds the Steward's wakes. The desk's standing prompt is
`docs/alert-desk-prompt.md`.

```
alert sources ──> ~/.cache/alert-desk/inbox.jsonl ──> drainAlertDesk (items decide) ──> outbox (receiver desk) ──> desk relay ──> desk thread
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

## Delivery guarantee

At-least-once, with stable ids. A wake's id comes from the event (`desk:<hash of family, signature and time>`), a replay after a crash makes the same id, and
an id already bound to an outbox row (any status) or tombstoned is never enqueued again. One window cannot be closed: a crash after the webhook accepts a
POST and before the row is committed `delivered` sends that wake once more after the restart (`src/core/relay.ts` describes it), under the same id. So the
desk skips an id it has already handled: its prompt says to search the thread for the id first and answer `repeat of <id>` (docs/alert-desk-prompt.md).

## The command allowlist is enforced

`src/desk-allowlist.ts` is a Claude Code PreToolUse hook that DENIES BY DEFAULT. It allows only: Bash in a fixed set of command shapes (journalctl,
systemctl status, example-tool reads, gh run view, git, docker ps/logs/inspect with a plain `--format`, and the Morning sweep's own commands);
Read, Grep and Glob under `/var/log`, `~/.cache/alert-desk` and `DESK_LOG_DIRS` (never a credential path, after `..` and symlinks are resolved); and the
Agent tool only to start a `example-gatherer` gatherer, which is how the desk fans out. Every other tool is refused: the write tools, every MCP tool, and any
name it does not know. A command's whole argument list is parsed: a flag that is not on that command's list is refused, a flag given twice in any
spelling (`--format` then `-f`) is refused, and every value is checked. `bun src/desk-allowlist.ts check '<command>'` tests one by hand.

The matcher must cover every tool, or the default deny never sees the tool it is meant to refuse. Install it in the desk project's `.claude/settings.json`
(`"*"` matches all tools, MCP tools included):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "bun <the Chamberlain checkout>/src/desk-allowlist.ts hook" } ] } ] } }
```

## Nothing changes until the desk is switched on

The desk is off until the adapter has a `desk-wake-url` (the drain reads nothing without it). The alert writers (the monitor's webhook and heartbeat, monitor)
append only when the desk is on: `ALERT_DESK_ENABLED=1` in their environment, or the flag file `~/.config/alert-desk/enabled` (`touch` it; remove it to
switch them off; no restart is needed).

## Go-live (the operator's approvals, in this order)

Migration 8 cannot be undone by the old build: a database from a newer build is refused (`checkVersion`), so going back needs the backup below.

1. **Back up the database first**, with the daemon running or stopped (this is an online-safe backup):
   `sqlite3 "${CHAMBERLAIN_STATE:-$HOME/.local/state/chamberlain}/chamberlain.db" ".backup '${CHAMBERLAIN_STATE:-$HOME/.local/state/chamberlain}/chamberlain.db.pre-alert-desk'"`
   (without the sqlite3 tool: `bun -e 'import {Database} from "bun:sqlite"; new Database(process.argv[1]).run("VACUUM INTO ?", [process.argv[2]])' <db> <backup>`).
   **To go back:** stop the daemon, `cp <backup> <db>`, `rm -f <db>-wal <db>-shm`, check out the old build, start it. Anything the new build did after the backup is lost.
2. Deploy and restart Chamberlain on this branch (migration 8 runs at startup).
3. Create the desk thread with `docs/alert-desk-prompt.md` as its first message, install the allowlist hook in its project, bind a webhook scheduled task to it,
   and save its URL as `desk-wake-url` (0600) and its thread id as `desk-thread` in the config directory.
4. `touch ~/.config/alert-desk/enabled` to switch the writers on.

## Config

`$CHAMBERLAIN_CONF/alert-desk.json` (all optional) and the environment:

```json
{ "windowMinutes": 15, "repeatHours": 24, "dailyCap": 30, "morningHour": 7, "timezone": "Etc/GMT+5", "maxAgeHours": 6, "enabled": true }
```

`ALERT_DESK_INBOX` overrides the inbox path. The T3 adapter needs a private `desk-wake-url` (a webhook bound to the desk thread) and, for its busy
gate, `desk-thread`; without the URL the desk is off and the inbox is not read. The first pass of each local day from `morningHour` sends the
morning wake, which runs the Morning sweep in the desk's prompt (the operator's 07:00 triage, folded in).

## Schema

(The rollback needs the backup in the go-live steps above.) Migration 8 adds a nullable `receiver` column to `outbox` and `held_wakes` (NULL is the Steward, as every row so far) and freezes it with the row.
`store.wakes.held(lane)` and `rows(status, lane)` read one receiver's wakes (`null`: the Steward's, a name: that receiver's, nothing: all of them);
`compose` takes one receiver's held wakes only. The Steward's relay passes `null`, the desk's passes `"desk"`.
