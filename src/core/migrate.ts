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
import { attachDeprecationLog, ConfigFileError, oldFileState, readConfigFile, SECRETS_DIR } from "./layout.ts";
import { assertPrivateDir, InsecureModeError, isPrivateFile } from "./private.ts";
import { checkVersion, SCHEMA_VERSION, SchemaTooNewError, versionOf } from "./schema.ts";
import { FlockBusyError, holdFlock, RelayLockUnavailableError } from "./singleton.ts";

/** json: one document. jsonl: one record per line. servers: servers.json. */
export type Kind = "json" | "jsonl" | "servers";
type Step = (data: unknown) => unknown;
type Dir = "conf" | "state";
export type StoredFile = { dir: Dir; name: string; kind: Kind };

/** Every versioned config file. */
export const FILES: StoredFile[] = [
	{ dir: "conf", name: "settings.json", kind: "json" },
	{ dir: "conf", name: "web.json", kind: "json" },
	{ dir: "conf", name: "sweep.json", kind: "json" },
	{ dir: "conf", name: "servers.json", kind: "servers" },
];

const stampStep: Step = (d) => (d && typeof d === "object" && !Array.isArray(d) ? { schemaVersion: 1, ...d } : d);
/** 1 -> 2 changed no shape for this kind: upgradeData stamps the new version. */
const sameShape: Step = (d) => d;

export const STEPS: Record<Kind, Step[]> = {
	json: [stampStep, sameShape],
	jsonl: [stampStep, sameShape],
	servers: [
		stampStep,
		// 1 -> 2: every entry names its adapter. Every server was T3 Code before adapters existed.
		(d) =>
			d && typeof d === "object" && Array.isArray((d as { servers?: unknown }).servers)
				? {
						...d,
						servers: (d as { servers: Record<string, unknown>[] }).servers.map((x) => ({
							...x,
							adapter: x.adapter ?? "t3",
						})),
					}
				: d,
	],
};

/** Pure: a record upgraded from `from` through every step to `to`. A version with no step is an error, never a skip. */
export function upgradeData(
	kind: Kind,
	data: unknown,
	from: number,
	to = SCHEMA_VERSION,
	steps: Record<Kind, Step[]> = STEPS,
): unknown {
	let d = data;
	for (let v = from; v < to; v++) {
		const step = steps[kind][v];
		if (!step) throw Error(`no migration for ${kind} from schemaVersion ${v}`);
		d = step(d);
		if (d && typeof d === "object" && !Array.isArray(d)) d = { ...(d as object), schemaVersion: v + 1 };
	}
	return d;
}

/** The version a parsed file or record claims; a file with no `schemaVersion` is version 0. */
const versionOfData = (_kind: Kind, what: string, d: unknown): number => {
	const o = (d && typeof d === "object" ? d : {}) as { schemaVersion?: unknown };
	return versionOf(what, o.schemaVersion);
};

const pathOf = (f: StoredFile, conf: string, state: string) => `${f.dir === "conf" ? conf : state}/${f.name}`;

type Entry = { path: string; what: string; kind: Kind };
function entries(conf: string, state: string): Entry[] {
	return FILES.filter(
		// a file the layout migration moved is not read again by its old name: a rewritten one is not this build's to check or upgrade
		(f) => f.dir !== "conf" || oldFileState(conf, f.name, false) !== "reappeared",
	)
		.map((f) => ({ path: pathOf(f, conf, state), what: f.name, kind: f.kind }))
		.filter((e) => existsSync(e.path));
}

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
/**
 * Throws SchemaTooNewError, naming the file, if any file holds a record from a newer Chamberlain. Reads only. Returns
 * each file's highest version and how many of its records are older than this build.
 */
export function assertSupported(o: { conf?: string; state?: string } = {}): FileStatus[] {
	const out: FileStatus[] = [];
	for (const e of entries(o.conf ?? CONF, o.state ?? STATE)) {
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
		out.push({ what: e.what, path: e.path, version: any ? version : SCHEMA_VERSION, old });
	}
	return out;
}

/** How long a migrator waits for another one that holds the lock, by default. A migration takes milliseconds; this is for a stuck one. */
export const LOCK_WAIT_MS = 30_000;

export type MigrationReport = { migrated: string[]; skipped: { what: string; why: string }[] };

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
	const waitMs = o.lockWaitMs ?? LOCK_WAIT_MS;
	let lock: { release(): void };
	try {
		lock = holdFlock(conf, { waitMs });
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
		return report;
	}
	try {
		o.whileLocked?.();
		// Read again under the lock: a migrator we waited for has already done its files.
		const todo = assertSupported({ conf, state }).filter((s) => s.old > 0);
		for (const e of entries(conf, state)) {
			if (!todo.some((s) => s.what === e.what)) continue;
			const st = statSync(e.path);
			if (!isPrivateFile(st)) {
				report.skipped.push({ what: e.what, why: "not a private regular file (mode exactly 0600)" });
				continue;
			}
			const text = readFileSync(e.path, "utf8");
			let next: string;
			if (e.kind === "jsonl") {
				next = text
					.split("\n")
					.map((l) => {
						if (!l.trim()) return l;
						let rec: unknown;
						try {
							rec = JSON.parse(l);
						} catch {
							return l;
						}
						const from = versionOfData(e.kind, e.what, rec);
						return from < SCHEMA_VERSION ? JSON.stringify(upgradeData(e.kind, rec, from)) : l;
					})
					.join("\n");
			} else {
				let rec: unknown;
				try {
					rec = JSON.parse(text);
				} catch {
					report.skipped.push({ what: e.what, why: "not JSON, left alone" });
					continue;
				}
				const from = versionOfData(e.kind, e.what, rec);
				if (from >= SCHEMA_VERSION) continue;
				next =
					JSON.stringify(
						upgradeData(e.kind, rec, from),
						null,
						e.kind === "json" || e.kind === "servers" ? 2 : undefined,
					) + (e.kind === "json" || e.kind === "servers" ? "\n" : "");
			}
			if (next === text) continue;
			const bak = `${e.path}.pre-schema-v${SCHEMA_VERSION}.bak`;
			if (!existsSync(bak)) copyFileSync(e.path, bak, constants.COPYFILE_EXCL);
			const tmp = `${e.path}.tmp-${process.pid}`;
			writeFileSync(tmp, next, { mode: 0o600 });
			renameSync(tmp, e.path);
			report.migrated.push(e.what);
		}
	} finally {
		lock.release();
	}
	return report;
}

/**
 * The first thing every entry point does. A newer file exits 3 with the reason; `migrate` also upgrades old files and
 * reports them through `log`. Returns normally only when every file is readable by this build.
 */
export function startup(
	o: {
		migrate?: boolean;
		log?: (event: string, data?: Record<string, unknown>) => void;
		conf?: string;
		state?: string;
	} = {},
) {
	try {
		// The directory that holds the secrets must itself be private (0700), or a file's mode protects nothing: refused before any file is read.
		const conf = o.conf ?? CONF;
		assertPrivateDir(conf, "the config directory");
		assertPrivateDir(`${conf}/${SECRETS_DIR}`, "the secrets directory");
		readConfigFile(conf); // a config.json that is unreadable, too new or writable by others stops the start here
		if (o.migrate) {
			if (o.log) attachDeprecationLog(o.log);
			const r = migrateStorage(o);
			if (r.migrated.length) o.log?.("schema-migrated", { files: r.migrated });
			for (const s of r.skipped) o.log?.("schema-migrate-skipped", s);
			if (o.log) startupLayout(conf, o.log);
		} else assertSupported(o);
	} catch (e) {
		if (e instanceof SchemaTooNewError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(3);
		}
		if (e instanceof InsecureModeError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(4);
		}
		if (e instanceof ConfigFileError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(2);
		}
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
