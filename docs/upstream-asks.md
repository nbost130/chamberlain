# Upstream asks

Chamberlain runs beside T3 Code and uses its public surface almost everywhere: the `/ws` orchestration protocol, `orchestration:read` and
`orchestration:operate` tokens, scheduled-task webhooks and the `t3` CLI. For the few things below it relies on internals T3 is free to
change. Each is a small supported API that would let the T3 adapter stop. None is a promise from T3; each can be filed on its own.

1. **A read of a thread's busy and queued state.** Today the adapter opens T3's `statev2.sqlite` read-only (the `orchestration_v2_projection_*`
   tables) to learn whether the Steward is working, how many turns are queued, its context size and its run timings. The ask is one read
   per thread with counts and timestamps (`running`, `queued`, `oldestQueuedAt`, `lastActivityAt`, `openRequestSince`, `contextTokens`),
   readable with an `orchestration:read` token. A T3 migration that renames a table makes the gate read "unknown", which counts as busy
   (wakes still go after a 20-minute ceiling) and raises an alarm.
2. **A "thread is waiting on input" event.** Today the adapter infers a wait from each `thread.updated` snapshot and then reads the
   projection to learn its kind, matching kind names (`user_input_request`, `approval_request`, `secret_request`, `*link*`). The ask is
   `thread.input-requested` (with the kind and a clipped summary) and `thread.input-resolved` on the shell stream.
3. **Documented commands.** The decision page answers question cards with `runtime-request.respond`, renames the Decisions thread with
   `thread.metadata.update` and steers a thread with `message.dispatch`, all through `orchestration.dispatchCommand`. The ask is to document
   them as supported, with payloads and the token scope each needs.
4. **Webhook idempotency.** A scheduled-task webhook cannot de-duplicate a repeated POST. If it honoured the `deliveryId` already in the
   body (or an `Idempotency-Key` header) for a day, the one window left in [DELIVERY.md](DELIVERY.md), a POST accepted just before a crash, would close.
5. **A way to withdraw a question card.** To close a card answered on the decision page, Chamberlain answers it with the operator's own
   choice. A `runtime-request.cancel`, or a documented "resolved elsewhere" outcome, would not put words in the card's answer record.
6. **A stable version document.** `GET /.well-known/t3/environment` returns `serverVersion` and `orchestrationProtocolVersion`, which the
   adapter reads at start to warn when a server is outside the tested range. The ask is to document it as stable and add the database
   migration number as a compatibility hint.
