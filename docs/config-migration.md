# Config migration: one file, and a `secrets/` folder

The first releases kept each setting in a file of its own in `~/.config/chamberlain` and read about twenty `CHAMBERLAIN_*` variables.
Now one file, `config.json`, holds every setting that is not a secret, and `secrets/` holds one 0600 file per token or webhook URL.
The prose you edit (`decision-rights.md`, `brief.d/`) stays as files, and so does `daemon.env`.

**You do nothing.** The first time the daemon or the page starts on an old directory it **moves** the files:

1. each secret is renamed into `secrets/<same name>` (one copy, mode 0600, its date kept: the token-age alarm reads it);
2. `config.json` is written;
3. only then is each migrated non-secret file, `steward-thread`, `decisions-thread` and `desk-thread` included, renamed `<name>.migrated`.

It moves instead of copying because a stale old file is read by tools outside Chamberlain (the Steward's hand-off reads `steward-thread`), and after a
Steward switch it would name a retired Steward. A crash at any step leaves every value readable, and the next start finishes the job.
**After the move nothing reads an old name.** The `.migrated` files are your safety copy (every key, even one this build never read): delete them whenever you like.
A file the migration could not move (a problem, printed by `config migrate`) is the one exception: it is still read from its old place, as a fallback, with one `config-deprecated` line in the events log.
(One older step is separate: the daemon and the page still upgrade an old file that has no `schemaVersion`, or version 1, in place with a `.bak` beside it, as they always did.)
To do it by hand, or to see what it will do first: `chamberlain config migrate --dry-run`, then `chamberlain config migrate`.
To undo it: `chamberlain config revert` (below).

## Where each old file went

| Old file | New home | Notes |
| --- | --- | --- |
| `settings.json` `principalName` | `config.json` `principal` | Renamed so the variable follows the rule below. |
| `settings.json` `t3BaseDir` | `config.json` `t3Dir` | Renamed. |
| `settings.json` `t3StateDb` | `config.json` `t3StateDb` | |
| `settings.json` `alertCommand` | `config.json` `alertCmd` | Renamed. |
| `settings.json` `compactTokens` | `config.json` `compactTokens` | |
| `settings.json` `settledMatch` | `config.json` `settledMatch` | |
| `settings.json` any other key | not migrated | A key this build never read had no effect; `config migrate` prints a `note:` naming it. |
| `servers.json` | `config.json` `servers` | The list only: `schemaVersion` is dropped. Entry fields are unchanged, and `tokenFile` / `operateTokenFile` still name a file, now in `secrets/`. |
| `web.json` | `config.json` `web` | `host`, `port`, `allowedHosts`, `threadLinks`, `mirrorLinks`, `decisionsServer`, `answerTokens`, `publicBase` unchanged. |
| `sweep.json` | `config.json` `sweep` | `{"checks": [...]}`. |
| `alert-desk.json` | `config.json` `alertDesk` | Every key unchanged. Only migrated if no group or other user can write the file (0600 or 0644): the Alert Desk trusts what it holds to widen what the desk may run. |
| `operating-rules.json` | `config.json` `operatingRules` | `schemaVersion` dropped. |
| `judge.json` | `config.json` `judge` | |
| `steward-thread` | `config.json` `threads.steward` | `chamberlain switch-steward` now writes the key. |
| `decisions-thread` | `config.json` `threads.decisions` | |
| `desk-thread` | `config.json` `threads.desk` | |
| `daemon.env` | stays (not moved); its `CHAMBERLAIN_*` settings are copied into `config.json` | See "Environment variables". systemd reads the file from the path in the unit, so it is not moved. |
| `decision-rights.md` | stays | Prose you edit. |
| `brief.d/` | stays | |
| `sweep-prompt.md`, `alert-desk-prompt.md`, `operating-rules.md` | stay | |

### Secrets

Each is **renamed into** `secrets/<same name>`, mode 0600, in a 0700 directory, with its date. Nothing is copied and nothing changes name.

| Old file | New path | What it is |
| --- | --- | --- |
| `wake-url` | `secrets/wake-url` | The Steward's webhook URL. |
| `compact-url` | `secrets/compact-url` | The compact webhook URL. |
| `desk-wake-url` | `secrets/desk-wake-url` | The Alert Desk's webhook URL. |
| `read-token` | `secrets/read-token` | The default server's read token. |
| `<server>-token` (for example `main-token`, `laptop-token`) | `secrets/<server>-token` | A server's read token. |
| `<server>-operate-token` (for example `laptop-operate-token`) | `secrets/<server>-operate-token` | A server's operate token (`web.answerTokens`). |
| `t3-operate-token` | `secrets/t3-operate-token` | The Decisions server's operate token (`web.decisionsServer`). |
| any other file that `tokenFile`, `operateTokenFile`, `decisionsServer.operateTokenFile` or `answerTokens` names | `secrets/<same name>` | |
| `wake-url.steward`, `wake-url.prev` | `secrets/wake-url.steward`, `secrets/wake-url.prev` | Hand-off files. A new Steward writes its URL to `secrets/wake-url.steward`. |

A secret that is a symlink to a regular file is written by content into `secrets/` (with the target's date) and the link is set aside as `<name>.migrated`; the target is untouched. A secret that is not mode exactly 0600 is **not moved** (and was never read): the migration prints it as a problem. `chmod 600` it and run `chamberlain config migrate` again.
A secret that `secrets/` already holds is never overwritten; if an old file of the same name is there too, it is flagged (see "An old name written again") and `secrets/` wins.

**After the move, a secret is read only from `secrets/`.** Writing a new token or webhook URL at the old path changes nothing: mint it into `secrets/<name>` (mode 0600). The token-age alarm and its text name `secrets/<name>` too.

## Environment variables

One rule now names the variable for a setting: **`CHAMBERLAIN_` + the config key in UPPER_SNAKE_CASE**. Every variable that was a setting already
follows it, so **no variable changed name**, and each still overrides its key. The environment wins over `config.json`, which wins over an old file.

| Variable (unchanged) | Key in `config.json` |
| --- | --- |
| `CHAMBERLAIN_PRINCIPAL` | `principal` |
| `CHAMBERLAIN_T3_DIR` | `t3Dir` |
| `CHAMBERLAIN_T3_STATE_DB` | `t3StateDb` |
| `CHAMBERLAIN_T3_ORIGIN` | `t3Origin` (new key; was environment-only) |
| `CHAMBERLAIN_ALERT_CMD` | `alertCmd` |
| `CHAMBERLAIN_COMPACT_TOKENS` | `compactTokens` |
| `CHAMBERLAIN_RECOVER` | `recover` (new key) |
| `CHAMBERLAIN_EXCLUDE` | `exclude` (new key; a list) |
| `CHAMBERLAIN_REPORT_QUIET_MS` | `reportQuietMs` (new key) |
| `CHAMBERLAIN_REPORT_HOLD_MS` | `reportHoldMs` (new key) |
| `CHAMBERLAIN_STALL_MS` | `stallMs` (new key) |
| `CHAMBERLAIN_CARD_UNVERIFIED_ALARM_MS` | `cardUnverifiedAlarmMs` (new key) |
| `CHAMBERLAIN_MAX_ATTEMPTS` | `maxAttempts` (new key) |
| `CHAMBERLAIN_GH` | `gh` (new key) |
| `CHAMBERLAIN_HEALTH_FORMAT_PATTERN` | `healthFormatPattern` (new key) |

These stay environment-only, with no key: `CHAMBERLAIN_CONF` and `CHAMBERLAIN_STATE` (they say where `config.json` is; `HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME` still pick the default directories), `CHAMBERLAIN_DRY` (a switch for one run),
`CHAMBERLAIN_VERBOSE`, `CHAMBERLAIN_ALARM_KEY` (set by Chamberlain for your alert command), `T3CODE_CLI_PATH`, `CLAUDE_CONFIG_DIR`, and the Alert Desk's own
`ALERT_DESK_INBOX`, `DESK_ASK_PATH` and `DESK_LOG_DIRS` (its hook and writers are not Chamberlain's processes). The variables the tests use
(`CHAMBERLAIN_TICK_MS`, `CHAMBERLAIN_RELAY_POLL_MS`, `CHAMBERLAIN_CRASH_AT`, `CHAMBERLAIN_TEST_ONLY`, `CHAMBERLAIN_TEST_ALERT_MARKER`) are unchanged and still undocumented.

**`daemon.env`.** It is not moved (systemd reads it from the path in the unit). The migration copies each `CHAMBERLAIN_*` setting in it that has a key into `config.json`, but only where no old file already gave that key, so
the setting survives when you drop the line. Where the two disagree (`settings.json` says one alert command and `daemon.env` another) `config.json` takes the file's value, the variable keeps
winning while it is in `daemon.env`, and the migration prints a `differs:` line: removing the variable then gives the file's value, as it did before. The file itself is left alone, and is never read unless it is mode 0600.

**A switch is `1` or `0`.** `CHAMBERLAIN_RECOVER=1` turns recovery on and `0` turns it off, as before. Any other value (`true`, `yes`) is ignored, as it was
(it read as "off"), so an install that set `CHAMBERLAIN_RECOVER=true` does not start recovering because of this upgrade. In `config.json` the key is `true` or `false`.

A number that is not usable (`CHAMBERLAIN_MAX_ATTEMPTS=soon`, `CHAMBERLAIN_COMPACT_TOKENS=soon`) is now ignored and the next source is used; it used to be read as `NaN` or `0`.

## An old name written again

A tool outside Chamberlain may still write `steward-thread`, or a re-minted `mac-token`, at the old path after the move. That file is **never read**: the value lives
where this page says it moved to. The daemon logs `config-legacy-reappeared` (once per file, with the file name and where its value lives now, never a value), and `chamberlain config show` prints a line for each:

```
REAPPEARED  steward-thread: written at its old place after the migration, and NEVER read. The value lives in config.json "threads.steward" (read it with: chamberlain config get threads.steward). Change settings in config.json.
REAPPEARED  laptop-token: written at its old place after the migration, and NEVER read. The secret lives in secrets/laptop-token. Mint new secrets into secrets/<name>, not at the old path.
```

A script that read `steward-thread` should run `chamberlain config get threads.steward` instead.

## Two commands for after the move

- **`chamberlain config get <key>`** prints one value, for a script: `config get threads.steward`, `config get web.port`, `config get stallMs`. A string prints bare, anything else as JSON; an unset key prints nothing, says so on stderr and exits 1.
  It **refuses a secret** (a name like `wake-url` or `laptop-token`, or anything under `secrets`): secrets are files in `secrets/`, read by the program that needs them.
- **`chamberlain config revert [--dry-run]`** puts the old layout back so an older build starts again: every `<name>.migrated` is renamed back, each moved secret goes back to its old name (date kept),
  the three thread files are written from `config.json`'s **current** thread ids (so a Steward switch since the migration does not bring a retired Steward back), and `config.json` is renamed `config.json.reverted`.
  Anything written at an old name in the meantime is set aside as `<name>.reappeared`, never overwritten. It is idempotent (a second run prints `nothing to revert`) and a crash at any step leaves every value readable.
  Settings edited in `config.json` after the migration are not carried back into the old files, and `secrets/web-token` (a secret with no old name) stays where it is.

## How to check that it worked

1. **Nothing is left to do.** `chamberlain config migrate --dry-run` prints `nothing to do: config.json and secrets/ already hold everything the old files do`.
   Any line starting `PROBLEM:`, `differs:` or `REAPPEARED` is something to look at; it exits 1 on a problem.
2. **Every value is read from the new place.** `chamberlain config show` prints each key with its source and every secret by name. Every key reads
   `(config.json)` (or `(env CHAMBERLAIN_...)` where you override it), none reads `legacy ...`, and every secret reads `secrets/`. It never prints a secret.
3. **The log agrees.** After the first start on the new build:

   ```sh
   sqlite3 ~/.local/state/chamberlain/chamberlain.db \
     "select t, event, data from events where event like 'config-%' order by id desc limit 10"
   ```

   `config-migrated` (once, with the key, secret and renamed-file names), and no `config-deprecated`, `config-migrate-failed` or `config-legacy-reappeared`.
   (The very first start of the page can log one `config-deprecated`: it reads `web` before the migration has run.)
4. **Nothing is left to delete.** The old files are gone from their old names (`ls ~/.config/chamberlain`). The `<name>.migrated` files are your safety copy: delete them when you are satisfied.
   Keep `decision-rights.md`, `brief.d/` and `daemon.env`, which were never moved.

## Things that behave a little differently

- **`config.json` is the one place.** After the migration, editing an old name changes nothing: it is never read. Edit `config.json`. To say "none" for a key, set it to `null`.
- **Modes.** `config.json` may be 0600 or 0644; it is refused if a group or other user can write it, or if it is a symlink. `secrets/` must be 0700 and each secret 0600; the daemon exits 4 on a wrong directory mode.
- **A typo is an error.** An unknown key in `config.json` stops the start with the key named, where an unknown key in `settings.json` used to be ignored.
- **Errors name the old file.** A problem in the `web` section still reads `web.json: ...`; read it as that section of `config.json`.
- **Downgrading.** Run `chamberlain config revert` first: an older build reads the old layout, and the old files are not there until you do.
- **Write once.** The migration runs when `config.json` does not exist; after that only `chamberlain config migrate` adds to it, and only files and keys it has not moved. Nothing is overwritten. A key set to `null` (`"threads": null`, `"alertCmd": null`) is kept as it is: it means "none". Every step is a rename or an atomic write, so a run that is stopped leaves no half-written file, and the next start finishes the job.
- **If the migration cannot write** (a read-only directory, another process holding the lock) the start goes on reading the old files (nothing was moved), with `config-migrate-failed` in the events log.
