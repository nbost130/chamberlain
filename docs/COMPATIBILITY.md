# Compatibility with T3 Code

This section is about the T3 adapter, which depends on a backend that changes under it. The core depends on no backend.

The T3 adapter is tested against **T3 Code server 0.1.8 to 0.1.9**, orchestration protocol 2. That range is one constant,
`T3_TESTED` in [`src/adapters/t3/compat.ts`](../src/adapters/t3/compat.ts). At start each watcher reads
`/.well-known/t3/environment` and, if the server is outside the range, logs `compat-warning`, prints a warning, and
**keeps running**: T3 changes between minor versions, and a warning is more useful than a refusal. The version is also in
the heartbeat record. (It is a different thing from the schema check above, which refuses newer files.)

The T3 adapter **relies on T3 internals** that are not a supported API:

- It reads T3's `statev2.sqlite` read-only, for whether the Steward has a turn running or queued, its context size, its
  provider identity, and run timings. Tables: `orchestration_v2_projection_runs`, `_messages`, `_turn_items`,
  `_runtime_requests`, `_provider_turns`, `_threads`, `_provider_threads`, `_provider_sessions`. If a T3 migration changes
  them, the gate reads "unknown", which counts as busy (wakes still go after a 20-minute ceiling) and raises an alarm.
- It answers cards and approvals, renames the Decisions thread and sends to threads with `orchestration.dispatchCommand`:
  `runtime-request.respond`, `thread.metadata.update`, `message.dispatch`.
- It reads the shell stream (`orchestration.subscribeShell`), thread projections, and the `/bounded` and `/history`
  HTTP views, and matches wait kinds by name (`user_input_request`, `approval_request`, `secret_request`, `*link*`).

[`upstream-asks.md`](upstream-asks.md) lists the small supported APIs that would remove these dependencies: a
busy/queued state read and a "thread is waiting on input" event first among them.

## Known limitations

- **Only the T3 adapter ships.** The contract is small and documented ([`ADAPTERS.md`](ADAPTERS.md), with a sketch for herdr in [`examples/herdr-adapter.md`](../examples/herdr-adapter.md)),
  and an in-memory fake runs the test suite, but no second real backend has been built or tested.
- **One Steward.** Chamberlain wakes a single thread. Several operators or several Stewards are not supported.
- **Delivery is at-least-once.** The webhook cannot de-duplicate, so a wake can arrive twice under one id and the Steward de-duplicates; see [DELIVERY.md](DELIVERY.md).
- **The page has no authentication** beyond its network binding (see [SECURITY.md](SECURITY.md)), and a tailnet is only as private
  as its members.
- **Steward health reads a Claude Code transcript.** On another provider it reports "unavailable" (and never "OK").
- **A token expires.** the read token (`secrets/read-token`) lasts as long as you minted it for; the daemon alarms at 25 days. A webhook stops
  working if its bound thread is deleted; repeated failed deliveries raise an alarm.
- **Wake timing is heuristic.** A finished turn is held for a quiet window (three minutes) in case more work follows, and
  "turn ended on a promise" and "turn ended handing a question back" are recognised by phrase patterns. Tune
  `CHAMBERLAIN_REPORT_QUIET_MS` and read [`src/core/decide.ts`](../src/core/decide.ts) before relying on either.
- **`chamberlain debug t3x send` is lightly tested** on T3 0.1.x. Linux and macOS only; Windows is untested.
- **Your checks run as you.** The `sweep` commands in `config.json` are executed directly (no shell) by the daemon's user; keep the file yours alone to write.
