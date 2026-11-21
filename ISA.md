---
phase: climbing
progress: 9/11
---

# Provider-independent model selection

## Ideal State

### L3
Operators keep Chamberlain useful when their available model provider changes, through one explicit configuration.

### L2
Every model-dependent feature uses the operator's selection and reports unsupported capabilities honestly.

- Pinned threads honor independent provider, model and effort selections.
- Direct inference uses capability-aware adapters with preserved isolation.
- Existing configuration migrates without a second runtime selection path.
- Failures preserve pending work and never silently switch providers.

### L1
The existing config document owns provider, model and supported options for every inference consumer. Pinned threads use T3's provider catalog and model-selection contract; isolated readers use explicitly selected no-tools adapters. Quota errors preserve work for an operator-selected provider switch. No provider installation, model name, billing fallback or hidden settings file is assumed.

## Vision
Changing the configured provider restores Decisions without reconfiguring unrelated features or requiring Claude.

## Criteria

- [x] ISC-11: A confirmed quota limit selects the first usable operator-approved backup for the same role and environment. A busy switch or exhausted list preserves the delivery for retry. Evidence: `src/adapters/t3/quota-failover.test.ts` replays 67 queued wakes across restart, including Desk confinement, quota recovery and one outage alarm.

- [x] ISC-1: Every model-dependent surface, including shipped agent launch templates, is inventoried. Falsifier: an unlisted call site in source or hidden setup templates.
- [x] ISC-2: Central configuration owns all supported model selections; unsupported Desk combinations are refused. Falsifier: a runtime provider/model default, an unsupported Desk send, or a webhook destination not verified against the selected server and thread.
- [x] ISC-3: Configured selection and failure behavior pass regression tests. Falsifier: an integration test fails.
- [x] ISC-4: Repository checks pass. Falsifier: `bun run checks` exits nonzero.
- [x] ISC-5: Non-Claude Decisions renders and relays a test answer. Falsifier: missing render or persisted answer evidence.
- [ ] ISC-6: Independent review passes. Falsifier: unresolved reviewer finding.
- [x] ISC-7: A recovered thread does not cause stale provider-failure wake cascades. Falsifier: replaying Claude failure, Grok recovery, then delayed Claude failure produces a new failure wake or retries obsolete work.
- [x] ISC-8: The final source and setup audit contains no active hard-coded model binding. Falsifier: a supported execution or setup path bypasses the documented central selection.
- [ ] ISC-9: The reviewed change ships through the normal release path, with compatible processes installed before live model configuration. Falsifier: a live process rejects the migrated schema or the deployed revision differs from the reviewed release.
- [x] ISC-10: The overhead monitor never holds more than `investigator.maxOpen` investigations or opens more than one per cooldown, even when a launch's outcome is lost, across a restart, a stale thread or a clock jump; an unreadable, missing or non-finite input crosses no limit; and its investigator launches only on the operator's explicit `overhead.investigator.model`. Falsifier: a lost response, a TTL expiry with a live thread, retention under repeated failures, a retry whose preflight is refused while T3 already made the thread, a restart that credits time, a clock reading before the stored launch, a disabled investigator's reconciliation, a missing baseline or fleet host (a host named `constructor` included, for the share and for the managed ratio), a `constructor` model name, a managed overhead ratio over anything short of full coverage (exactly `minCoverage` included), a delayed retry of a pending reservation beside a new reservation (two launch calls in one tick, or two threads inside one cooldown), an unmapped launched butler or investigator feeding a partial numerator into the share or the ratio, an exclusion that is configured and cannot be applied (fleet off, LifeOS unreadable, an id that cannot be looked up), or Steward and classifier spend made for an experiment, yields a second launch or a crossing; or a launch uses a model the operator did not select. Evidence: tick.reservation.test.ts, tick.clock.test.ts, experiments.numerator.test.ts, tick.test.ts, trigger.test.ts, metrics.fail-closed.test.ts, prices.test.ts, collect.test.ts, investigator.test.ts; `bun run checks`.

## Anti-criteria

No silent provider fallback, duplicate execution, lost queued work, weakened isolation, second settings store, or upstream T3 changes. Publication and cutover require the complete model-binding audit, passing checks and independent review.

No new keys written into the live config before the pinned daemon supports them. Live configuration changes occur only through the normal release/cutover path. Checkout tests use isolated configuration directories.

## Test Strategy

ISC-11 includes a turn starting during catalog discovery and a Claude model with only a different model's quota exhausted. The relay must keep the running turn and the selected model, respectively.

| ISC | type | method | tool |
| --- | --- | --- | --- |
| ISC-1 | manual | Compare source call sites with inventory | Source audit |
| ISC-2 | bun-test | Configuration and migration integration tests | bun test src/core/llm |
| ISC-3 | bun-test | Regression suite | bun test |
| ISC-4 | manual | All checks | bun run checks |
| ISC-5 | manual | Real T3 render and persisted test answer | bun src/decisions.ts repost |
| ISC-6 | manual | Independent Sol review | Goal and final diff |
| ISC-7 | bun-test | Reordered failure/recovery event and queued delivery regressions | bun test src/adapters/t3 src/core/delivery |
| ISC-8 | manual | Source and setup audit with independent review | rg source audit and Sol review |
| ISC-9 | manual | Release revision and service/config compatibility read-back | Normal release/cutover probes |
| ISC-10 | bun-test | Lost-outcome, restart, stale-thread, clock-jump, retention and fail-closed scenarios, plus launch idempotence against the fake T3 | bun test src/core/overhead src/adapters/t3/investigator.test.ts |
| ISC-11 | bun-test | Role-specific quota pools, approved backup order, project restrictions, two outages and webhook deliveries on the active generation across restart | bun test src/adapters/t3/model-quota.test.ts src/adapters/t3/quota-failover.test.ts |

## Decisions

- Direction authorized by the accepted goal. Execution remains inline with an independent final review.
- Changes to mail/config.test.ts and classifier/config.test.ts model-default expectations approved; safety checks preserved. Other existing tests remain read-only.
- Mail is currently a configuration/database seam; no mailbox processing is added.
- Preserve explicit per-role selections; never silently fallback to another provider. Stale failure suppression must inspect the newest run and its recovered state, including work already queued for delivery.
- Decisions fixture and classifier observability enum snapshot updates approved.
- Crash fixtures may use the configured fake T3 model server; the reader HTTP sender and fake server WebSocket sender have scoped scanner approval. Wake sends remain forbidden.
- The live import was unsafe: the pinned daemon rejected the new models key and crashed. The Steward preserved the block in models.wip.json and removed it from live config. Do not write live config before cutover. The compatibility replay is a manual real-reader probe: the installed older parser rejects a synthetic models document, the checkout parser accepts it, and neither writes configuration. The import dry-run regression separately proves byte-for-byte preservation. The WIP file is recovery evidence, never a runtime configuration source.
- Four additional existing-test updates approved: web/links.test.ts, adapters/t3/post.test.ts, classifier/classify.classifyidle.test.ts and modules/index.test.ts. Preserve their security and failure assertions.
- The remaining post.repost.test.ts fixture update is approved. All Decisions entry points now use the same central selection contract; the retired CLI transport is removed.
- Keep the scope in Chamberlain and related adapters. Unsupported Alert Desk providers and unmanaged gatherers must be refused with queued work preserved. No upstream T3 work or follow-up is authorized.
- Publication and gated cutover are conditionally authorized after every in-scope hard-coded model binding is addressed and verified with tests and Sol review. Install compatible code before adding live configuration keys. This supersedes the earlier local-only hold.
- Related code, fixture and contract fixes are authorized as a batch; preserve all safety assertions.
- Reconciliation with current main found that migration 18 now belongs to prepare-pr links. The classifier migration must be 19, preserving both classifier history and prepare-pr links when upgrading an existing version-18 database.
- The CLI-sender architecture assertion is approved to require zero CLI senders; its single RPC sender assertion is unchanged.
- The overhead monitor (`overhead` section, src/core/overhead/) adds no hard-coded model binding: the Steward's tokens are priced for the model `models.steward` names, from the operator's own `overhead.prices` (none shipped), and the investigator thread launches only on `overhead.investigator.model`, an explicit T3 selection parsed by the same `threadModel` check and preflighted by the same `launchSelectionFor` as every pinned thread, with no default and no fallback.
- Audit round 1 of the overhead monitor (PR #109): an investigation is a reservation (`pending`, `open`, `closed`) recorded with its brief before any command goes out, with every id derived from its id so a repeat is the same commands. Only a launch that sent nothing releases it; an unknown outcome counts as launched and is reconciled against T3 (`getThreadProjection`, absent only on T3's "No orchestration projection exists" reply). A stale reservation (past `ttlHours`) stays held until T3 shows the thread idle, archived or gone; no clock alone frees a slot. Closed history is capped, held reservations never are. A missing baseline, a missing fleet host or a non-finite value is unavailable and crosses nothing, price lookup is by own key, and failed reads show an error class, never tool text. This is ISC-10.
- Audit round 2 of the overhead monitor (PR #109): a reservation leaves `pending` only by reconciliation that positively shows no thread for its seed, or shows the thread with its brief; a refused preflight, an error or an unknown answer keeps it held. The cooldown is measured from the launch time stored in Chamberlain's state (round 3 removed the persisted clock and its restart credit: a restart adds nothing, a clock reading before the stored launch means the cooldown is not over, inside one process the larger of the monotonic and wall time is taken unless either is below zero; a real forward wall-clock jump is accepted as time). A disabled investigator reconciles and closes only. Experiments are out of the numerator (Steward rows by session, classifier calls by thread, one read-only lookup that fails to "unavailable"). The managed ratio triggers only at full coverage and with every fleet host reporting, and host lookups use Maps. This is ISC-10.
- Audit round 3 of the overhead monitor (PR #109): the cooldown has no restart credit (above). An exclusion that is configured (`excludeProjects`/`excludeLabels`) and cannot be applied, because `fleet.source` is "off", LifeOS cannot be read or an id cannot be looked up, makes every affected figure unavailable (Steward and classifier spend, the no-op rate) and nothing triggers. Launched butlers and investigators count in the managed coverage: any one with no LifeOS session leaves the caused spend short and blocks a trigger, the ratio still shown as partial. This is ISC-10.
- Audit round 4 of the overhead monitor (PR #109): the launch rule is one rule in one place. `reconcile.ts` `send` is the only door to a launch call and spends the tick's single launch budget; a retry reuses its reservation's key; `decide` (trigger.ts) lets a pending reservation block any new one whatever `maxOpen` is and counts the cooldown from the later of creation and the last launch call (written before the call). `maxOpen` stays the cap on held reservations. When an exclusion cannot be applied the classifier figure is unavailable with every other money figure. An unmapped launched thread makes the caused spend, the share and the managed ratio unavailable. Tests: tick.launch-rule.test.ts (with a seeded property test), trigger.test.ts, experiments.numerator.test.ts, managed.launched.test.ts. This is ISC-10.
- Overhead monitor, experiments excluded (PR #109): `overhead.excludeProjects` and `excludeLabels` (empty by default, no operator name in source) keep experiments such as eval runs out of the fleet total and out of every Chamberlain-caused figure; the headline overhead share is Chamberlain-caused spend over fleet spend with experiments out of both, with the Steward-only share beside it. Tests: experiments.test.ts.
- Overhead monitor, managed overhead ratio (PR #109): Chamberlain-caused spend over the spend of the T3 threads it supervised in the window. A thread is managed when Chamberlain's own database records an action on it (a `fire` event, which carries the server, or a wake or report queued for the Steward naming it), minus the threads it runs itself; their spend is read from LifeOS by `sessions.metadata->>'t3_thread_id'`. A managed thread with no session is unmapped, its spend unknown and never $0; coverage is mapped over managed, below 100% the ratio is partial and only reports (`triggers.managedRatio.minCoverage`, 0.9, is the reporting bar; a trigger needs full coverage and every fleet host reporting). Tests: managed.test.ts, managed-spend.test.ts, managed.collect.test.ts. This is ISC-10.
- Overhead monitor, launched threads by record (PR #109): the butlers and investigators Chamberlain launched are identified by its own launch records (the butler ledger, the investigations in its state) and their spend is read by thread id, never by a project or a title; `fleet.spawnedProjects` and the title-matched investigator slice are gone. A launched thread with no session adds nothing and is said so; a failed read makes the caused spend unavailable.
- Landing #110 after #108 and #109 (2026-11-19, Steward under R110): origin/main was merged in, not rebased. `layout-schema.ts` SECTIONS keeps both `overhead` and `activeHold`, and `daemon.ts` keeps both sides' imports. The two features together took `engine-core-work.ts` past biome's 300-line cap, so `housekeepingChecks` now uses one local `failed` handler for its identical clip-and-log catches. The events, fields and order are unchanged. #109's launch-time fix (44c5db0, `send` reads both clocks at the call) is ISC-10, with its test in tick.clock.test.ts. This merge serves ISC-4. Evidence: `biome check src scripts` and `tsc --noEmit` are clean, and the pre-push suite and CI run on the merge head.

## Status

The expanded setup audit also found initial Steward, Decisions and Desk instructions, plus sweep worker launches, bypassing central selection. All now use the same role-aware launch preflight; workers require explicit models.worker, Desk enforces the same unsupported-driver/gatherer refusals before launch, and its setup installs the hook before the first model turn. Decisions no longer requires Claude's ToolSearch. Steward handoff uses the expanded brief-start output. Final checks and fresh source review are being repeated for this complete setup coverage.

Review of the expanded handoff found that omitting the startup mode promoted a TEST predecessor to live. The template now carries the predecessor's explicit mode into brief start and stops TEST handoffs before live switch checks or trigger retirement. Regression probes verify both rendered modes and retained test isolation.

The committed-head Review.ts gate has a separate false positive: its redactor replaces a valid SECRET_SHAPES.find expression with a placeholder, which the reviewer treats as source syntax. The real D12 test passes (12 tests, 148 assertions) and full type checking passes. Publication remains blocked by that gate; no self-waiver or weakening of redaction is authorized.

Fresh review of f9a8f99 found two missed shipped launch paths: Steward handoff inherited the project's default, and Butler chose a model and machine ad hoc. Both are in scope. The launch templates must consume validated central selections before their first turn, and Butler must require its own explicit models.butler selection. The audit includes hidden command templates; no upstream T3 changes are authorized. Publication remains held for these fixes and a fresh review.

The shipped templates now consume the read-only `models selection` preflight, which returns the authenticated server identity and centrally configured model/options. The existing T3 launch tool retains its permission contract. Handoff retains its current tasks on preflight failure; Butler requires an explicit selection and no longer escalates models/effort or changes machines automatically. Integration tests exercise both roles, switching providers, missing credentials, invalid options, quota, unavailable server identity, and the real CLI output. Copied templates must be updated during release/cutover.

Frozen HEAD 03eb805 passed all 3486 tests, all repository checks, binary smoke, real Grok render/answer relay, and fresh Sol source review (62 independent safety tests). Publication then stopped at the public-content gate because pre-existing hostile-test fixtures contained credential-shaped synthetic strings. Those fixtures must generate obvious dummy credentials at runtime while preserving every redaction assertion; the scanner remains unchanged. Final checks and Sol review also cover that fixture-only release repair.

Release review found that model preparation and webhook delivery could address different servers or threads. Publication is held until Chamberlain verifies the actual pinned URL against the selected server's existing scheduled-task contract, refuses mismatches without spending attempts, and passes fresh checks and review. No upstream change is needed.

Live acceptance also reproduced two catalog timeouts: T3's full configuration request waits for unrelated network discovery. Its existing configuration stream returned the same provider catalog in 954 ms. Model preparation and migration must use that stream, with regression coverage proving an unavailable full-config request cannot block a configured provider. Unknown catalog data still fails closed.

Both adapter fixes are implemented. The mismatched-server control failed before the fix and passes now; destination, redirect, queued-work and compaction regressions pass. The full suite passed 3484 tests after updating only the two switched-thread crash fixtures' fake webhook bindings. The final catalog-stream change then passed 18 focused integration tests and a real configured Grok repost without changing live configuration. Final frozen-tree full checks and independent review remain release gates; their output belongs to the release evidence, not a predicted pass here.

Source scope verified; publication/cutover is separate. `docs/MODELS.md` inventories configuration owners, adapters and capability boundaries. Both `bun test` and `bun run checks` passed 3426 tests with zero failures and 20666 assertions. Final source review by a fresh Sol agent reported `VERDICT: PASS` within the accepted scope. Its nonzero-exit billing and concurrent-import reporting findings were fixed and independently retested.

Real acceptance used the checkout's `bun src/decisions.ts repost` with an isolated central configuration importing the existing explicit Grok selection. The live pinned page remained in service: a Grok run completed `html_render`; the synthetic question was present in its queue API; choosing its test option persisted exactly one view-key answer claim and one delivered relay; the receiving Grok run completed with the requested acceptance acknowledgement. This verifies the checkout's configured repost interoperating with the pinned page, not a deployment of the new page. The live configuration hash stayed unchanged throughout. The older-reader compatibility probe confirms why deployment must precede schema migration.

Safety regressions cover stale recovered-source failures, unreadable source holds, generation switches during preparation, failed-provider work retention, no-tools isolation, missing credentials, quota refusal, encoded capability redaction before truncation, migration preservation and honest null/import reporting. No unsupported Desk operation is silently redirected to Claude. Final command outputs and private live-run evidence are retained outside the public source tree.
