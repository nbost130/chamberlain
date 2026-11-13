# Contributing

Thanks for looking at Chamberlain. It is a small codebase with a strong opinion: **no model calls in the daemon**, and
every wake delivered once. Changes that keep both are welcome.

## Set up

```sh
bun install
bun test
bunx tsc --noEmit
```

Both must pass before a change is merged (CI runs both). Tests use scratch directories (`CHAMBERLAIN_CONF`,
`CHAMBERLAIN_STATE`) and never touch `~/.config/chamberlain` or `~/.local/state/chamberlain`; keep it that way. Anything that
talks to a backend takes its network and clock as dependencies so the tests drive the real code.

## Where code goes

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first. In short:

- **`src/core/`** is backend-agnostic and must not import from `src/adapters/`. It meets a backend only through the
  adapter contract, `src/core/adapter.ts`. `src/architecture.test.ts` reads every import (type-only ones too) and fails the
  build on a violation, so there is no way to take a shortcut by accident.
- **`src/adapters/<name>/`** holds everything about one backend. It imports `src/core/` and its own folder, never another
  adapter. A new backend is one new folder and one line in `src/adapters/index.ts`; see
  [`docs/ADAPTERS.md`](docs/ADAPTERS.md).
- **`src/web/`** is the decision-queue page. Its modules work through the contract; only `server.ts` uses the registry.
- **`src/testing/`** holds test doubles. Core and page tests build their backend with `fake-adapter.ts`, never with a
  real adapter. If your change needs the core to know something about a backend, add a capability to the contract (with
  its degraded path and a test against the fake) rather than an import.

A change to behaviour the core owns (a rule, delivery, the hold gate) is tested in `src/core/` against the fake, so it is
proved for every backend. A change to one backend is tested in that adapter's folder.

## Commits and releases

Commits use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`chore:`, with `!` or a `BREAKING CHANGE:` footer for a breaking change. [release-please](https://github.com/googleapis/release-please)
reads them to open the release pull request and write `CHANGELOG.md`, so write the subject as the changelog line.

## Rules of the house

- **Schema versions.** Any file Chamberlain keeps carries a `schemaVersion`. If you change a stored shape, bump
  `SCHEMA_VERSION` in `src/core/schema.ts`, add a step to `STEPS` in `src/core/migrate.ts` that upgrades the previous version, and
  add a test in `src/core/migrate.test.ts` (the 1 -> 2 step, which gave `servers.json` entries an `adapter`, is the model). Never read a newer version leniently.
- **Database migrations.** Add a migration to `MIGRATIONS` in `src/core/migrations.ts`; never edit one that has been released. One that is
  edited in place while its branch is open (10 and 11 were) leaves any development database that ran its earlier draft at that version for
  good, so that database must be rebuilt: delete `chamberlain.db` and its `-wal` and `-shm` files, then start again or run
  `legacy-import.ts`. Do not open a database a newer draft made with an older draft build: the version matches, so nothing refuses it.
- **Names.** A name for a table, column, state, mode, config key, log event or feature is the industry term when one exists for the same concept (check the sources in [docs/GLOSSARY.md](docs/GLOSSARY.md)), and every new name gets a glossary entry in the same change: its definition, the standard term it follows or why it is Chamberlain's own, and a source link.
- **Private files.** A file holding a token, URL, command or address must be refused unless it is mode 0600.
- **T3 internals.** A new dependency on T3's database or on an undocumented command belongs in the T3 adapter, in the Compatibility
  section of the README and in `docs/upstream-asks.md`. Bump `T3_TESTED` in `src/adapters/t3/compat.ts` only after running the
  suite against that T3 version.
- **No personal setup.** Nothing that names a person, host, repository or private tool belongs anywhere in the repository. Make it a
  config value, or an example under `examples/`.
- **Wake text is data to the Steward.** Anything from a thread (titles, messages, check output) must reach it fenced as
  untrusted data.

## Reporting a security problem

The page and daemon handle tokens and can answer questions for a person. Please report a suspected vulnerability
privately to the maintainers (see the repository's security policy once it is published) rather than in a public issue.
