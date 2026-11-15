# Alert triage (slice 1)

Critical alerts can be routed to the Steward as durable obligations, behind
`alertTriage.enabled` (default **false**). With the flag off, the engine reads
`alertTriage` once to check the enable bit, then calls today's `drainAlertDesk`
unchanged. Flag-off goldens cover desk held rows, items, cursor and log event
names from that drain — not a claim that config.json is never opened.

## Config (`alertTriage` in config.json)

```json
"alertTriage": {
  "enabled": false,
  "rules": [
    { "id": "swap-full", "match": { "family": "swap-full" }, "outcome": "steward-task" },
    { "id": "key-expiring", "match": { "family": "secret-expiring" }, "outcome": "human", "right": "secrets" }
  ],
  "ackMinutes": 15,
  "batchPerTick": 5,
  "maxInFlight": 10,
  "readBudgetBytes": 8388608
}
```

Rules apply to **critical** events only. Outcomes: `steward-task`, `human`
(requires a reserved `right`), or `pass-through`. Unmatched criticals become
steward-tasks (`default-critical`). Non-criticals always use today's desk path.

## Operator commands

```
chamberlain triage ack <ao_ref>
chamberlain triage resolve <ao_ref>
chamberlain triage status <ao_ref>
chamberlain triage list [--all]
```

Refs are opaque `ao_…` digests. Ack stops the SLA ladder; resolve closes the
obligation (the next event for that family opens a new occurrence).
