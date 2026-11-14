# Contributing

Thanks for looking at Chamberlain. It is a small codebase with a strong opinion: **no model calls in the daemon** unless the
operator opts in (the judge, and the idle-thread classifier, are both off until configured), and every wake delivered once. Changes that keep both are welcome.

## Set up

You need [Bun](https://bun.sh) 1.4 or newer (developed on 1.4.4); Chamberlain uses `bun:sqlite`, `Bun.serve` and `Bun.spawn`. Linux and macOS are
supported.

```sh
bun install
bun test
bunx tsc --noEmit
bun run check         # the formatter (Biome, 120 columns); `bun run format` fixes it
```

All of them must pass before a change is merged (CI runs them). `bun test` seals itself off from your machine (`src/test-setup.ts`): it
runs with a scratch `HOME`, `CHAMBERLAIN_CONF` and `CHAMBERLAIN_STATE`, drops every `CHAMBERLAIN_*` variable your shell has, and points the
alert command at a recorder, so it can never read your settings or run your alert command. A test that raises an alarm through a real
engine passes `alert: noAlert` (`src/testing/alert.ts`); the run fails at the end if anything called the recorder. Anything that talks to a
backend takes its network and clock as dependencies so the tests drive the real code.

The tests also use a few variables that are not for users: `CHAMBERLAIN_TICK_MS` (the daemon's housekeeping interval),
`CHAMBERLAIN_RELAY_POLL_MS` (how often the relay looks at the outbox), `CHAMBERLAIN_CRASH_AT` (SIGKILL the process right after a named step
in `src/core/crash.ts`, used by `crash.test.ts`) and `CHAMBERLAIN_TEST_ONLY=1` (lets the test-only helpers in `src/testing/` run outside `bun test`).

## Running from a checkout

Run each tool as `bun src/<file>`, where the binary runs `chamberlain <name>` (`chamberlain help` lists them; the table is `COMMANDS` in
`src/core/config.ts`):

```sh
bun src/daemon.ts                        # chamberlain daemon
bun src/ask.ts '<json>'                  # chamberlain ask
bun src/web/server.ts --test             # chamberlain web --test: the page on fixture data, no wakes
```

A tool added to `COMMANDS` needs a loader in `src/cli.ts` and an exported `main(argv)` (`src/cli.test.ts` checks both). Any command a prompt
or an alarm teaches is built with `selfCommand("<name>")`, never by hand, so it is `chamberlain <name>` in the binary and
`bun <checkout>/src/...` from source. Diagnostic tools are listed in `DEBUG_COMMANDS` and run as `chamberlain debug <name>`.

The standalone binaries are built, smoke-tested and packaged by scripts (the release workflow runs them when release-please makes a release):

```sh
bun scripts/build.ts --targets linux-x64         # dist/chamberlain-<version>-linux-x64.tar.gz, .sha256 and SHA256SUMS; no --targets builds all four
bun scripts/smoke.ts dist/chamberlain-*-linux-x64.tar.gz   # runs it from an empty directory: --version, the page, ask, the hand-off, the daemon
bun scripts/render-formula.ts --sums dist/SHA256SUMS       # the Homebrew formula, from packaging/homebrew/chamberlain.rb.tmpl
```

Run the smoke test the way the tests run: with a scratch `HOME`, `CHAMBERLAIN_CONF` and `CHAMBERLAIN_STATE` (it sets its own for the binary, but
`bun scripts/...` itself should not see your live config).

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
  good, so that database must be rebuilt: delete `chamberlain.db` and its `-wal` and `-shm` files, then start again. Do not open a database a newer draft made with an older draft build: the version matches, so nothing refuses it.
- **Names.** A name for a table, column, state, mode, config key, log event or feature is the industry term when one exists for the same concept (check the sources in [docs/GLOSSARY.md](docs/GLOSSARY.md)), and every new name gets a glossary entry in the same change: its definition, the standard term it follows or why it is Chamberlain's own, and a source link.
- **Private files.** A file holding a token, URL, command or address must be refused unless it is mode 0600.
- **T3 internals.** A new dependency on T3's database or on an undocumented command belongs in the T3 adapter, in the Compatibility
  section of `docs/COMPATIBILITY.md` and in `docs/upstream-asks.md`. Bump `T3_TESTED` in `src/adapters/t3/compat.ts` only after running the
  suite against that T3 version.
- **No personal setup.** Nothing that names a person, host, repository or private tool belongs anywhere in the repository. Make it a
  config value, or an example under `examples/`.
- **Wake text is data to the Steward.** Anything from a thread (titles, messages, check output) must reach it fenced as
  untrusted data.

## Reporting a security problem

The page and daemon handle tokens and can answer questions for a person. Please report a suspected vulnerability
privately to the maintainers (see the repository's security policy once it is published) rather than in a public issue.
