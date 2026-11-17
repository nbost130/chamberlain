# Model configuration and capability inventory

`config.json` is the only live settings document. The `models` section selects the execution adapter, provider, model and options for pinned threads and isolated readers. There is no default model and no automatic provider fallback. Edit this document to switch; selections are read for each operation. An omitted or null role is unconfigured, not permission to use Claude.

## Pinned threads

`models.steward`, `models.decisions` and `models.desk` have this shape. Values below are placeholders to replace with entries from your T3 server's provider catalog:

```json
{
  "models": {
    "decisions": {
      "adapter": "t3",
      "server": "your-server-name",
      "instanceId": "your-provider-instance",
      "model": "your-model-id",
      "options": { "reasoningEffort": "high" }
    }
  }
}
```

Use only option IDs and values that the selected model advertises; omit unsupported options. Providers must be enabled, installed, available and authenticated where required. A reported exhausted usage window blocks preparation until reset or an explicit configuration change. The existing `web.decisionsServer` or `web.answerTokens` operate-token grant authorizes selection on the named server; credentials remain in `secrets/`. Missing credentials never cause a CLI fallback.

Model preparation and import read T3's authenticated configuration-stream snapshot. They do not wait for the full configuration endpoint's unrelated remote-network discovery or keep a second catalog on disk. Missing or malformed snapshots refuse execution.

Before sending, Chamberlain confirms the thread's selection through T3. A busy thread cannot change provider. Decisions also binds the validated selection to the dispatch command. Steward, compaction and Alert Desk retain their existing bound webhook transport and single outbox relay. Chamberlain verifies the exact destination against the selected server's authenticated scheduled-task snapshot: an enabled, unblocked webhook bound to that same thread, using the server's own endpoint or its advertised relay URL. Unknown, mismatched, signed or unbound tasks hold work without spending an attempt. The relay pins that verified URL across preparation and sending; HTTP redirects are refused. T3 uses the bound thread's current model. Configuring a model does not retarget a webhook or grant additional tools.

**Current Alert Desk limitation:** its command allowlist is enforced by a Claude Agent hook. T3's catalog does not advertise an equivalent enforcement capability for other drivers, so desk preparation rejects them. A configured external gatherer is also rejected: its agent definition would introduce a separate model-selection owner. Pending desk work stays queued without consuming delivery attempts. Any future support must enforce the same isolation and central selection within Chamberlain and its adapters; this release makes no upstream T3 changes.

After release/cutover, preserve an existing installation with `chamberlain models import <server>` (from source: `bun src/models.ts import <server>`). Add `--dry-run` to inspect the import without writing any settings. It reads the configured pinned threads' actual T3 selections, validates them and imports missing roles through the existing locked configuration migration writer. Explicit settings, including null, win. A concurrent thread-ID change rejects the import. After import, change `config.json`; T3 thread settings are no longer a parallel selection source.

## Isolated readers

`models.classifier`, `models.mailDriver`, `models.mailEscalate` and `models.mailTop` accept two supported adapters:

| Adapter | Required configuration | Capability and failure boundary |
| --- | --- | --- |
| `openai-chat` | `model`, `endpoint`; optional `keyFile`, `effort`, `timeoutMs` | Chat-completions-compatible HTTP endpoint; HTTPS or loopback HTTP, no redirect, tool definitions or tool execution. Non-success HTTP, incomplete output and tool requests fail closed. Unsupported effort is rejected by the endpoint, never retried without it. |
| `claude-cli` | `command`, `model`; optional `effort`, `timeoutMs` | Explicit opt-in to Claude's CLI contract. Fixed no-tools, no-MCP, no-settings, no-session arguments. Input travels on stdin; output and stderr never become diagnostic text. API-key environment variables are removed to avoid accidental billing changes. |

HTTP credentials are a plain filename in the existing secrets directory, supplied only as a Bearer header. An unbilled local endpoint may omit credentials. The HTTP adapter is a protocol choice, not an implicit OpenAI account. It can use any explicitly configured endpoint implementing that contract. An arbitrary agent CLI cannot be substituted for a no-tools reader.

Enable the generic classifier with `sweep.idleParents.classifier.provider: "model"` and its existing `allowTextToLeaveMachine: true` consent. Existing redaction, per-run/day budgets, unknown-on-failure behavior and probability-bank validation still apply. HTTP classifiers additionally require `accountingUsdPerCall`: your conservative charge per attempted request for budget accounting, including failed requests. Zero is explicit and appropriate only for an unbilled endpoint. The cache identity includes the adapter, endpoint, model and options, so changing providers does not reuse another provider's answer.

Mail currently exposes configuration, status and storage only; its processing pipeline is not implemented. Its role selections are validated centrally and require the existing mail consent before any configured reader can receive mail. No mail model is selected by default.

## Source inventory

| Feature / source | Configuration owner | Execution adapter | Requirements / limits |
| --- | --- | --- | --- |
| Decisions (`src/decisions.ts`, `adapters/t3/post.ts`) | `models.decisions`, `threads.decisions`, existing web grant | T3 RPC via `model.ts` and `ping.ts` | Catalog selection/options, operate token, `html_render` tool supplied by T3; view capability only, never page key |
| Steward and compaction (`adapters/t3/index.ts`) | `models.steward`, committed Steward generation (config thread is its mirror), existing wake/compact URLs | T3 selection preparation + existing webhook relay | Selection, rights and destination share one generation; a concurrent switch holds the send without consuming an attempt |
| Alert Desk (`adapters/t3/index.ts`, `core/desk/`) | `models.desk`, `threads.desk`, `alertDesk` and desk webhook | Same preparation and relay; currently requires `claudeAgent` driver | Other drivers are unsupported because the tool allowlist uses a Claude hook; no silent fallback |
| Desk gatherer (`core/desk/alert-desk-prompt.ts`, `desk-hook.ts`) | Legacy `alertDesk.gatherer` names an external agent definition | Unsupported by the central selection adapter | Preparation refuses configured gatherers; portable isolation and central selection remain unfinished |
| Generic classifier (`core/classifier/model-provider.ts`) | `models.classifier`, `sweep.idleParents.classifier` policy | `core/llm/reader.ts` | No tools; redacted bounded state; consent and budgets; failure is unknown |
| Specialized Jev classifier (`core/classifier/providers.ts`) | `sweep.idleParents.classifier.jev` in the same config | Existing TypeSafe/Noul HTTP adapter | Explicit model and key, probability-head protocol; cannot substitute arbitrary chat models into that protocol |
| Rules classifier (`core/classifier/providers.ts`) | `sweep.idleParents.classifier.provider: rules` | Deterministic local rules | No model or credentials |
| Recovery judge (`core/ops/judge.ts`) | `judge.triggers` and `judge.backends` in the same config | Existing operator-configured argv backend, no shell interpolation | Explicit executable/arguments choose provider, model and effort; scrubbed error only, strict verdict JSON; absent/failing judge hands off unjudged |
| Mail (`modules/mail/model-config.ts`) | `models.mailDriver/mailEscalate/mailTop`, `mail` policy | Isolated reader contract reserved for future pipeline | Explicit consent; no mailbox processing or invented execution path |
| Source-thread retry, direct answers and accepted goals (`adapters/t3/ping.ts`, `waiting.ts`) | Existing source thread's operator-selected T3 model | Existing T3 dispatch | Resumes the source thread, never selects a substitute provider; daemon retries never steer a running/waiting turn |
| Provider health (`adapters/t3/steward.ts`, `transcript.ts`) | Configured Steward thread; `stewardTokens` opts into transcript measurement | T3 projection for general health; Claude transcript parser for optional token detail | Non-Claude transcript detail is unavailable, never falsely healthy; operational delivery does not require that detail |
| Process infrastructure (`core/llm/spawn.ts`, `daemon.ts`) | Selected reader or existing daemon config | Argument-array subprocesses | No hidden model selection; test subprocesses are fixtures |

Audit command: `rg -n 'claude|codex|model|provider|inference|Bun.spawn' src docs examples`. Claude mentions in the isolated CLI implementation, transcript parser, migration, examples and historical tests describe explicit contracts; they do not select a default provider.

The remaining provider/model literals have explicit purposes: adapter and protocol identifiers select supported contracts; migration and database enums preserve historical records; tests use synthetic or explicitly configured models; historical classifier measurements name the models actually measured. The legacy `haikuProvider` helper is exercised by compatibility tests only: runtime configuration rejects `haiku` and routes configured readers through `models.classifier`. Butler records store an operator-supplied model as metadata and never execute it. Neither constitutes a live selection path.

## Migration and recovery

Upgrade every process sharing a configuration directory before adding `models`. Older pinned builds reject unknown keys and cannot read this schema. Do not run a checkout's import against the live configuration while an older pinned daemon or page still uses it. Stage and validate the configuration in an isolated directory, follow the installation's normal release/cutover path, and only then import selections with the released executable. A rollback must restore the prior compatible configuration before starting the older executable. A saved WIP document is not a settings source.

`chamberlain config migrate` relocates explicit legacy Haiku and mail selections into `models` and removes their legacy settings. It never invents a model or executable when the old installation relied on defaults: choose them explicitly. The old Haiku runtime selector is rejected until migrated. Jev and judge backends already have explicit owners in the same central document and retain their specialized contracts.

Provider preparation failure holds a wake without consuming a send attempt. An actual transport attempt retains its existing bounded retry and idempotency rules. A recovered source thread suppresses delayed failure notifications; an obsolete queued failure becomes a cancelled tombstone. Active recovery or an unreadable source holds failure delivery rather than asserting success. No error authorizes switching to a different provider.
