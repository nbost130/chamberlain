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

## Config

`$CHAMBERLAIN_CONF/alert-desk.json` (all optional) and the environment:

```json
{ "windowMinutes": 15, "repeatHours": 24, "dailyCap": 30, "morningHour": 7, "timezone": "Etc/GMT+5", "maxAgeHours": 6, "enabled": true }
```

`ALERT_DESK_INBOX` overrides the inbox path. The T3 adapter needs a private `desk-wake-url` (a webhook bound to the desk thread) and, for its busy
gate, `desk-thread`; without the URL the desk is off and the inbox is not read. The first pass of each local day from `morningHour` sends the
morning wake, which runs the Morning sweep in the desk's prompt (the operator's 07:00 triage, folded in).

## Schema

Migration 8 adds a nullable `receiver` column to `outbox` and `held_wakes` (NULL is the Steward, as every row so far) and freezes it with the row.
`store.wakes.held(lane)` and `rows(status, lane)` read one receiver's wakes (`null`: the Steward's, a name: that receiver's, nothing: all of them);
`compose` takes one receiver's held wakes only. The Steward's relay passes `null`, the desk's passes `"desk"`.
