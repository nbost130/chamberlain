# Upstream asks: small supported T3 APIs that would remove Chamberlain's reliance on internals

Chamberlain runs beside T3 Code and is not part of it. Almost everything it does goes through T3's public surface
(the `/ws` orchestration protocol, `orchestration:read` and `orchestration:operate` tokens, scheduled-task webhooks,
the `t3` CLI). A few things do not, and for those it reads or relies on internals that T3 is free to change. This page
lists what we use, and the small supported APIs that would let us stop.

Nothing here is a promise from T3; it is a wish list written so it can be posted as issues. Each ask is
independent, small, and read-only unless stated.

## 1. A read of a thread's busy / queued state (the main one)

**What we do today.** Before posting a wake to the Steward's webhook, Chamberlain must know whether that thread is
working or has turns queued, because a wake sent to a busy thread only queues behind it (a `202` means "accepted", not
"started"). It opens `statev2.sqlite` read-only and queries:

- `orchestration_v2_projection_runs` (rows in `queued`, `starting`, `preparing`, `running`) for the counts and the
  oldest queued `requested_at`,
- `orchestration_v2_projection_messages` (to see that a queued run is a `/compact`),
- `orchestration_v2_projection_turn_items` (the latest non-user item's `updated_at`, to tell "queued but moving" from
  "stalled"),
- `orchestration_v2_projection_runtime_requests` (an unresolved card in the latest turn, which holds everything behind it).

The same database is read for the Steward's context size (`orchestration_v2_projection_provider_turns`,
`$.tokenUsage.usedTokens`), its provider session identity (`..._threads`, `..._provider_threads`,
`..._provider_sessions`) and run timings (`queue-waits.ts`).

**The ask.** One supported read, over RPC or HTTP, per thread:

```
GET /api/orchestration/threads/:id/activity
{ "running": 1, "queued": 2, "oldestQueuedAt": "2026-11-09T10:00:00Z",
  "lastActivityAt": "2026-11-09T10:04:12Z", "openRequestSince": null,
  "contextTokens": 183204 }
```

Counts and timestamps only, readable with an `orchestration:read` token. That replaces every table above except the
provider identity, which `contextTokens` plus the existing thread projection would cover.

**Why it matters.** The table and column names are not an API. A T3 migration that renames one makes Chamberlain's gate
read "unknown", which it treats as busy (it still posts after a 20-minute ceiling), and raises an alarm after five failed
reads. It degrades loudly, but it degrades.

## 2. A "thread is waiting on input" event

**What we do today.** The daemon subscribes to the shell stream (`orchestration.subscribeShell`) and infers a wait from
each `thread.updated` snapshot: `pendingRuntimeRequest.id` appearing, or `status` becoming `waiting`. It then calls
`orchestration.getThreadProjection` for that thread to learn what kind of wait it is (question card, command approval,
secret request, machine-link request) and to read the question text. Kinds are matched by name
(`user_input_request`, `approval_request`, `secret_request`, `*link*`), and the link request's name has differed across
versions, so it is matched with a regular expression.

**The ask.** A first-class event on the shell stream:

```
{ "kind": "thread.input-requested", "threadId": "...", "requestId": "...",
  "requestKind": "question" | "approval" | "secret" | "link",
  "summary": "<the question or the command, clipped>", "at": "..." }
{ "kind": "thread.input-resolved",  "threadId": "...", "requestId": "...", "by": "user" | "agent" | "timeout" }
```

With it Chamberlain would not need a projection read per wait, would not match kinds by name, and would learn the
moment a card is answered in its own thread, which today it infers from `pendingRuntimeRequest` going away.

## 3. A documented `runtime-request.respond`

The decision page answers question cards and approvals with `orchestration.dispatchCommand` and
`type: "runtime-request.respond"`, and renames the Decisions thread with `thread.metadata.update`. Both worked on
T3 0.1.x but are not documented as stable. The ask is only to document them (and `message.dispatch`, used to steer a
running thread) as supported commands, with their payloads, and to say which token scope each needs.

## 4. Webhook idempotency

A scheduled-task webhook cannot dedupe a repeated POST, so Chamberlain makes every wake an outbox row before sending, has one
relay send it under a frozen delivery id, commits it delivered when accepted, and puts the id in the text so the Steward can recognise
a repeat. There is still one unavoidable window: the webhook accepts a POST and the daemon dies before that commit. If the webhook honoured the `deliveryId` already in the body (or an `Idempotency-Key` header) for a day,
that window would close.

## 5. A way to withdraw a question card

T3 has no withdraw for a card. To close a card whose item was answered on the decision page, Chamberlain answers the
card with the operator's own choice through `runtime-request.respond`. A `runtime-request.cancel` (or a documented
"resolved elsewhere" outcome) would be cleaner and would not put words in the card's answer record.

## 6. Version negotiation

`GET /.well-known/t3/environment` already returns `serverVersion` and `orchestrationProtocolVersion`, and Chamberlain
reads them at start to warn when a server is outside the tested range (`src/adapters/t3/compat.ts`). The ask is to document that
document as stable, and to add the database migration number as a compatibility hint, so a tool that must read the
database can say "this migration is newer than the one I was tested against".
