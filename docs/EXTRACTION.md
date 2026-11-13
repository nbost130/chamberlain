# Extraction notes

Chamberlain was extracted from a private working system (a repository called legacy-wake, run as one person's operations
layer for their T3 threads). This page records what was dropped, what was kept, what was made generic, and the
judgment calls, so the next reader can see why the code looks the way it does. The old git history was not carried
over: it holds personal rulings and hostnames. The tree was seeded from the last committed state only.

> The layout described below is the one at extraction. The source has since been reorganised around an adapter layer:
> backend-agnostic modules are in `src/core/` and T3's in `src/adapters/t3/` (see [ARCHITECTURE.md](ARCHITECTURE.md)), and its
> state moved from files into one SQLite database with one item system. The file names below (`queue.jsonl`, `woken/`,
> `held-wakes.json`, ...) are the layout at extraction; `bun src/cli/import.ts` reads them into the database.

## Dropped, and why

| Dropped | Reason |
| --- | --- |
| `src/breaker.ts`, `src/breaker.test.ts`, `deploy/merge-breaker.example.json` | The fix-forward merge breaker, which had already become a **stability gate** before extraction: a gate on three change-stability metrics (rework, revert and change-failure rate), with audit and enforce modes, hysteresis, a human-only waiver and two alert channels. It was wired to one organisation's repository and metrics endpoint, so nothing in it shipped; its generic parts (the gate framework, a landing check, GitHub-computed metrics) are on the [roadmap](ROADMAP.md). |
| `src/pipeline.ts`, `pipeline-collect.ts`, `pipeline-tick.ts` and their tests, the schema fixture for that tool's database, `docs/pipeline-monitor.md` | A monitor for one specific CI-review tool's SQLite state, on two named machines. Tied to that tool's schema, and less than its design document suggested: the GitHub and CI-event half was designed but never built. Its mechanism (items with a repeat policy, an error never reads as clear, a maximum, one digest) is what the item system and the [roadmap](ROADMAP.md) carry forward. |
| `src/gate-check.ts` and test | Landing check that read the same tool's one-way-door gates and the stability gate. Bors- and tool-specific. |
| `src/sync-*.ts` (a notebook sync script) | `scp`s a personal notebook from one named laptop to one named server. |
| The `rounds` code in `sweep.ts` and `src/rounds.test.ts` | Counted fix rounds on PRs by looking for one organisation's review-bot comment markers through a private GitHub wrapper. |
| The machine, disk, PR-readiness and merged-PR checks in `sweep.ts` | They ssh'd to one laptop, read the pipeline tool's database and called a private GitHub wrapper for one repository. Replaced by configurable external checks (see below). |
| The rulings.md importer in `rulings.ts` (`parseRulingsMd`, `classify`, `legacyKeys`, `migrate`, `cardAnswersFromDb`) | It migrated one person's hand-written markdown file into `rulings.jsonl`, classifying lines by reading T3's card answers from the state database. A one-off. Dropping it also removes one dependency on T3's database. |
| The "Landing" and stability-gate sections of the Steward hand-off in `brief.ts` | Described the dropped gate-check and breaker. |
| The hard-coded operating-rules excerpt in `rules.ts` | It lifted named lines from two private rules files. The line-picking machinery is kept; the choice of lines is now your `operating-rules.json`. |
| The two machine-tunnel units in `deploy/systemd/` | Tunnels to two specifically named machines. |
| `.claude/settings.json`, `CLAUDE.md` | Absolute personal paths and one person's project instructions. |
| `docs/decision-queue-followups.md`, `docs/drafts/*`, `docs/questions-thread-setup.md` | Internal review notes, an unposted feature-request draft, and the setup message of a retired thread. |
| The "FORMAT CONTRACT" hook marker in `steward-health.ts` | A private prompt-hook convention. The format signal now takes your own pattern (`CHAMBERLAIN_HEALTH_FORMAT_PATTERN`) and is off by default. |
| Alert paths to a private alert script and a personal alerting service in `daemon.ts` | Replaced by one generic `alertCommand`. |
| `pipeline` from `HOLDABLE_KINDS` | The pipeline monitor was its only user. |

## Kept as it was

`decide.ts`, `daemon.ts` (minus the dropped monitors), `rpc.ts`, `deliver.ts`, `hold.ts`, `queue.ts`, `queue-waits.ts`,
`items.ts`, `ask.ts`, `ruling.ts`, `decided.ts`, `afk.ts`, `butler.ts`, `history.ts`, `peek.ts`, `crash.ts`,
`report.ts`, `rights-sent.ts`, `synthetic-wake.ts`, `t3x.ts`, `steward-health.ts` (see below), and `src/web/*`: the page,
the card mirror, the title keeper, the cards settler and the inline views. The security features are unchanged: the
page binds only to loopback or Tailscale addresses, every config file must be mode 0600, and the daemon's token is
read-only. Their tests came along: the private system's 655 tests became 516 after the dropped modules' tests left and
new ones for schema versioning, migration, compatibility, config, servers and the sweep checks arrived.

## Made generic

- Paths: `~/.config/legacy-wake` is `~/.config/chamberlain`, `~/.cache/legacy-wake` is `~/.cache/chamberlain`.
- Environment: `LEGACY_WAKE_*` is `CHAMBERLAIN_*`. The wake prefix `[legacy-wake]` is `[chamberlain]`.
- The T3 base directory (default `~/.t3`, with `userdata/statev2.sqlite`) is configurable (`t3BaseDir`, `t3StateDb`).
- The operator's name is `principalName` in `settings.json`, defaulting to "the operator". It is used in every wake,
  the hand-off and the away mandate.
- Server names are examples. The default single server is called `local`. A server entry can carry `sshHost`, used only
  to ask `git` about a worktree path that lives on another machine.
- `sweep.ts` keeps its clock, de-duplication, runaway-thread check and message building; the project-specific checks
  became `sweep.json`, a list of commands that print findings as JSON. A failing command is a check in error and forces a
  full sweep.
- `brief.ts` builds a generic hand-off; its operating rules come from `operating-rules.json` or `operating-rules.md`.
- `pass-rod.ts` became `switch-steward.ts`.
- systemd and launchd units are examples with no personal labels; `.claude/commands/steward-*.md` and
  `docs/steward-*-prompt.md` are templates.
- The `servers.json` shape is now `{ "schemaVersion": 2, "servers": [...] }`, each entry naming its `adapter`; the bare array and version 1 are still read, as T3 servers.

## Judgment calls the owner should check

1. **The retired Questions-thread card path was removed after extraction.** `relayCard`, `recoverCardClaims`, `web/cards.ts`,
   `testing/card-harness.ts`, the optional `questions-thread` file and their tests are gone. The one-wake ledger stays (as the `claims` table, once the state moved into the database): the
   page's claim on an item's one wake is what its crash tests exercise. Old `answered-on-card` events in a `queue.jsonl` still fold as before.
2. **The tested T3 range (0.1.8 to 0.1.9).** Inferred from the versions installed where this was built, not from a
   compatibility matrix. Widen it only after running the suite against that server.
3. **Answer rights on the page.** `questionsServer` was renamed `decisionsServer`, and one server, identified by a
   hard-coded host name, was special-cased. Now the server whose origin equals `decisionsServer.origin` gets that token, and `answerTokens` grants
   it to others by name.
4. **`steward-health.ts` is Claude-Code-provider specific** (it reads the Steward's Claude Code transcript). It stays
   because it is useful, but it should be flagged as such to users on other providers.
5. **Rulings are a proposal-then-confirm model.** That is the project's opinion about authority and was kept intact.
6. **Fixtures.** `report.replay.json` is a recorded timeline with one thread renamed; `steward-health.jsonl` is
   synthetic. Both contain only placeholder ids.
7. **The `Steward` signature.** The daemon recognises a thread the Steward instructed by its message starting with the
   word `Steward`. Renaming the role would need changing `stewardInstruction` in `decide.ts` and the hand-off text.
