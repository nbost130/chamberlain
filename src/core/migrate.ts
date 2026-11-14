/**
 * Schema migration of the CONFIG files, the ones people edit (settings.json, web.json, sweep.json, servers.json). One small module that
 *  - refuses to start on a file written by a NEWER Chamberlain (assertSupported), and
 *  - upgrades OLDER or unversioned files (a hand-written file has no schemaVersion) to the current SCHEMA_VERSION, in place (migrateStorage).
 *
 *   bun src/core/migrate.ts            check every config file, upgrade the old ones (backups beside them)
 *   bun src/core/migrate.ts --check    only report; change nothing
 *
 * State does not live in files any more: it is in the database, whose own versioned SQL migrations are in
 * src/core/migrations.ts (a newer database is refused by openStore).
 *
 * STEPS[kind][v] upgrades a record from version v to v+1, so a file at any older version walks the chain. This build
 * has two steps per kind (0 -> 1: stamp `schemaVersion`; 1 -> 2: re-stamp, and each servers.json entry gains its `adapter`). The daemon and the
 * page run migrateStorage at start; every command-line tool runs only assertSupported.
 *
 * One migrator at a time is the kernel's doing: a `flock(2)` exclusive lock on the config directory, held for the whole rewrite (singleton.ts
 * `holdFlock`). It is released when the holder ends or dies, and it is never broken by age: an earlier version used a lock file that any
 * other process removed after 120 s, so a slow migration could be entered twice and its owner could delete its successor's lock.
 */
import { constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { CONF, STATE } from "./config.ts";
import { startupLayout } from "./config-migrate.ts";
import { readConfigFile } from "./layout.ts";
import { attachDeprecationLog } from "./layout-legacy.ts";
import { ConfigFileError, SECRETS_DIR } from "./layout-schema.ts";
import { type Entry, entries, upgradeData, versionOfData } from "./migrate-steps.ts";
import { assertPrivateDir, InsecureModeError, isPrivateFile } from "./private.ts";
import { checkVersion, SCHEMA_VERSION, SchemaTooNewError } from "./schema.ts";
import { FlockBusyError, holdFlock, RelayLockUnavailableError } from "./singleton.ts";

/** The raw records of a file: a list for jsonl (a torn line is `undefined`), one value otherwise, or `undefined` if it isn't JSON. */
function parse(e: Entry): unknown[] {
	const text = readFileSync(e.path, "utf8");
	if (e.kind === "jsonl")
		return text
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				try {
					return JSON.parse(l) as unknown;
				} catch {
					return undefined;
				}
			});
	try {
		return [JSON.parse(text) as unknown];
	} catch {
		return [undefined];
	}
}

export type FileStatus = { what: string; path: string; version: number; old: number };

/** One file's highest record version and how many of its records are older than this build. Throws SchemaTooNewError on a newer one. */
function statusOf(e: Entry): FileStatus {
	let version = 0,
		old = 0,
		any = false;
	for (const d of parse(e)) {
		if (d === undefined) continue;
		const v = checkVersion(e.what, versionOfData(e.kind, e.what, d));
		version = any ? Math.max(version, v) : v;
		any = true;
		if (v < SCHEMA_VERSION) old++;
	}
	return { what: e.what, path: e.path, version: any ? version : SCHEMA_VERSION, old };
}

/**
 * Throws SchemaTooNewError, naming the file, if any file holds a record from a newer Chamberlain. Reads only. Returns
 * each file's highest version and how many of its records are older than this build.
 */
export function assertSupported(o: { conf?: string; state?: string } = {}): FileStatus[] {
	return entries(o.conf ?? CONF, o.state ?? STATE).map(statusOf);
}

/** How long a migrator waits for another one that holds the lock, by default. A migration takes milliseconds; this is for a stuck one. */
export const LOCK_WAIT_MS = 30_000;

export type MigrationReport = { migrated: string[]; skipped: { what: string; why: string }[] };

/** One line of a jsonl file, upgraded when it is a record older than this build; a blank or torn line, or a current record, comes back as it was. */
function upgradeLine(e: Entry, l: string): string {
	if (!l.trim()) return l;
	let rec: unknown;
	try {
		rec = JSON.parse(l);
	} catch {
		return l;
	}
	const from = versionOfData(e.kind, e.what, rec);
	return from < SCHEMA_VERSION ? JSON.stringify(upgradeData(e.kind, rec, from)) : l;
}

/**
 * The file's text with every older record upgraded, or undefined when the file is left as it is: it is not JSON (and says so in
 * `report.skipped`) or already current.
 */
function upgradedText(e: Entry, text: string, report: MigrationReport): string | undefined {
	if (e.kind === "jsonl")
		return text
			.split("\n")
			.map((l) => upgradeLine(e, l))
			.join("\n");
	let rec: unknown;
	try {
		rec = JSON.parse(text);
	} catch {
		report.skipped.push({ what: e.what, why: "not JSON, left alone" });
		return undefined;
	}
	const from = versionOfData(e.kind, e.what, rec);
	if (from >= SCHEMA_VERSION) return undefined;
	const pretty = e.kind === "json" || e.kind === "servers";
	return JSON.stringify(upgradeData(e.kind, rec, from), null, pretty ? 2 : undefined) + (pretty ? "\n" : "");
}

/** Replaces the file with `next` through a temporary file and a rename at mode 0600, after keeping a `.bak` of it the first time. */
function replaceFile(e: Entry, next: string): void {
	const bak = `${e.path}.pre-schema-v${SCHEMA_VERSION}.bak`;
	if (!existsSync(bak)) copyFileSync(e.path, bak, constants.COPYFILE_EXCL);
	const tmp = `${e.path}.tmp-${process.pid}`;
	writeFileSync(tmp, next, { mode: 0o600 });
	renameSync(tmp, e.path);
}

/** Upgrades each file in `todo` (the ones with older records), noting what it did or why it did not in `report`. */
function upgradeFiles(conf: string, state: string, todo: FileStatus[], report: MigrationReport): void {
	for (const e of entries(conf, state)) {
		if (!todo.some((s) => s.what === e.what)) continue;
		if (!isPrivateFile(statSync(e.path))) {
			report.skipped.push({ what: e.what, why: "not a private regular file (mode exactly 0600)" });
			continue;
		}
		const text = readFileSync(e.path, "utf8");
		const next = upgradedText(e, text, report);
		if (next === undefined || next === text) continue;
		replaceFile(e, next);
		report.migrated.push(e.what);
	}
}

/**
 * The kernel lock on the config directory, or undefined with the reason in `report.skipped` when another migrator held it for the whole wait
 * or this platform cannot lock. Any other failure is thrown.
 */
function takeLock(conf: string, waitMs: number, report: MigrationReport): { release(): void } | undefined {
	try {
		return holdFlock(conf, { waitMs });
	} catch (e) {
		if (e instanceof FlockBusyError)
			report.skipped.push({
				what: "*",
				why: `another process is migrating (it held the lock on ${conf} for the whole ${Math.round(waitMs / 1000)} s wait); nothing was changed, and readers accept the old files. Run again when it has finished`,
			});
		else if (e instanceof RelayLockUnavailableError)
			report.skipped.push({
				what: "*",
				why: `cannot lock the config directory on this platform, so nothing was migrated (${e.message})`,
			});
		else throw e;
		return undefined;
	}
}

/**
 * Upgrades every file that holds records older than SCHEMA_VERSION. Each rewrite goes through a temporary file and a
 * rename, keeps mode 0600, and leaves `<file>.pre-schema-v<n>.bak` (the file as it was) the first time. A file that is
 * not mode 0600 is skipped with a reason: readers still accept unversioned records, so a skipped file costs nothing. Only one process
 * migrates at a time, by a kernel `flock` on the config directory (see below); another one waits `lockWaitMs` (default 30 s) for it, then
 * skips, never entering while the first is inside and never breaking its lock. `whileLocked` runs once the lock is held (a test seam).
 * Throws SchemaTooNewError before touching anything.
 */
export function migrateStorage(
	o: { conf?: string; state?: string; check?: boolean; lockWaitMs?: number; whileLocked?: () => void } = {},
): MigrationReport {
	const conf = o.conf ?? CONF,
		state = o.state ?? STATE;
	const report: MigrationReport = { migrated: [], skipped: [] };
	const status = assertSupported({ conf, state }).filter((s) => s.old > 0);
	if (!status.length) return report;
	if (o.check) {
		report.skipped.push(
			...status.map((s) => ({
				what: s.what,
				why: `${s.old} record${s.old === 1 ? "" : "s"} older than schemaVersion ${SCHEMA_VERSION} (not changed: --check)`,
			})),
		);
		return report;
	}
	// One migrator at a time, enforced by the kernel: a flock(2) on the config directory itself, held for the whole rewrite and released when it
	// ends or when this process dies. A second migrator waits for the first, up to a deadline, and then gives up without changing anything. No
	// lock is ever broken by age, so a slow migration is never entered twice and a lock is only ever released by its own holder.
	const lock = takeLock(conf, o.lockWaitMs ?? LOCK_WAIT_MS, report);
	if (!lock) return report;
	try {
		o.whileLocked?.();
		// Read again under the lock: a migrator we waited for has already done its files.
		upgradeFiles(
			conf,
			state,
			assertSupported({ conf, state }).filter((s) => s.old > 0),
			report,
		);
	} finally {
		lock.release();
	}
	return report;
}

type StartupOptions = {
	migrate?: boolean;
	log?: (event: string, data?: Record<string, unknown>) => void;
	conf?: string;
	state?: string;
};

/** The upgrade `startup` runs for an entry point that owns the files: migrate, then report what was done and the layout move through `log`. */
function migrateAtStartup(o: StartupOptions, conf: string): void {
	if (o.log) attachDeprecationLog(o.log);
	const r = migrateStorage(o);
	if (r.migrated.length) o.log?.("schema-migrated", { files: r.migrated });
	for (const s of r.skipped) o.log?.("schema-migrate-skipped", s);
	if (o.log) startupLayout(conf, o.log);
}

/** Says why a start is refused and exits with that reason's code (3 too new, 4 insecure mode, 2 unusable config.json); any other error is not this one's to handle. */
function exitForRefusedStart(e: unknown): void {
	const code =
		e instanceof SchemaTooNewError ? 3 : e instanceof InsecureModeError ? 4 : e instanceof ConfigFileError ? 2 : 0;
	if (!code) return;
	console.error(`chamberlain: ${(e as Error).message}`);
	process.exit(code);
}

/**
 * The first thing every entry point does. A newer file exits 3 with the reason; `migrate` also upgrades old files and
 * reports them through `log`. Returns normally only when every file is readable by this build.
 */
export function startup(o: StartupOptions = {}) {
	try {
		// The directory that holds the secrets must itself be private (0700), or a file's mode protects nothing: refused before any file is read.
		const conf = o.conf ?? CONF;
		assertPrivateDir(conf, "the config directory");
		assertPrivateDir(`${conf}/${SECRETS_DIR}`, "the secrets directory");
		readConfigFile(conf); // a config.json that is unreadable, too new or writable by others stops the start here
		if (o.migrate) migrateAtStartup(o, conf);
		else assertSupported(o);
	} catch (e) {
		exitForRefusedStart(e);
		throw e;
	}
}

export function main(argv: string[] = process.argv.slice(2)) {
	const check = argv.includes("--check");
	try {
		const status = assertSupported();
		for (const s of status)
			console.log(
				`${s.what}\tschemaVersion ${s.version}${s.old ? `\t${s.old} older record${s.old === 1 ? "" : "s"}` : ""}`,
			);
		if (!status.length) console.log("no Chamberlain files found");
		const r = migrateStorage({ check });
		for (const w of r.migrated) console.log(`migrated ${w} (backup: ${w}.pre-schema-v${SCHEMA_VERSION}.bak)`);
		for (const s of r.skipped) console.log(`skipped ${s.what}: ${s.why}`);
	} catch (e) {
		if (e instanceof SchemaTooNewError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(3);
		}
		throw e;
	}
}

if (import.meta.main) main();
