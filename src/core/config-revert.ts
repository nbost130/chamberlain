/** Putting the old config layout back (revertLayout) so an older build starts again. */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isObject } from "./config-fold.ts";
import type { AfterStep } from "./config-migrate.ts";
import { movedBeforeCrash } from "./config-plan.ts";
import { FlockBusyError, holdFlock, RelayLockUnavailableError } from "./flock.ts";
import { readConfigFile, syncDir, writeFileDurable } from "./layout.ts";
import { JOURNAL, MIGRATED_SUFFIX, NON_SECRET_HOME } from "./layout-legacy.ts";
import { CONFIG_FILE, LEGACY_THREAD_FILES, SECRETS_DIR } from "./layout-schema.ts";

export type RevertReport = {
	/** What was put back, as lines for the operator: `restore <file>`, `move secrets/<name> back to <name>`. */
	done: string[];
	/** Things to know that are not failures. */
	notes: string[];
	/** What could not be, and why. */
	problems: string[];
	skipped?: string;
};

/** `base` if nothing is there, else `base.1`, `base.2`, ...: a name that never replaces a file. */
function freeName(conf: string, base: string): string {
	let n = base;
	for (let i = 1; existsSync(`${conf}/${n}`) || isLink(`${conf}/${n}`); i++) n = `${base}.${i}`;
	return n;
}
const isLink = (p: string) => {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
};
/** The newest `config.json.reverted[.N]` (the highest N), if any: a revert that crashed after setting config.json aside left it. */
function latestReverted(conf: string): string | undefined {
	let best: { name: string; n: number } | undefined;
	try {
		for (const e of readdirSync(conf)) {
			const m = /^config\.json\.reverted(?:\.(\d+))?$/.exec(e);
			if (m && (!best || Number(m[1] ?? 0) >= best.n)) best = { name: e, n: Number(m[1] ?? 0) };
		}
	} catch {
		// EMPTY_CATCH_OK: an unreadable directory has no reverted file to find.
	}
	return best?.name;
}

/** Everything one revert step needs: where, what it reports, whether it only says what it would do, and the two ways it changes the directory. */
type Reverter = {
	conf: string;
	report: RevertReport;
	would: boolean;
	/** Records the step, and unless this is a dry run does it and calls the test seam. */
	act: (line: string, fn: () => void, step: string) => void;
	/** Sets whatever is at `name` aside under a free name, so the next step can use `name`. */
	setAside: (name: string, suffix: string, why: string) => void;
};

function makeReverter(conf: string, report: RevertReport, would: boolean, after: AfterStep): Reverter {
	const act: Reverter["act"] = (line, fn, step) => {
		report.done.push(`${would ? "would " : ""}${line}`);
		if (would) return;
		fn();
		after(step);
	};
	const setAside: Reverter["setAside"] = (name, suffix, why) => {
		if (!isLink(`${conf}/${name}`)) return;
		const to = freeName(conf, `${name}${suffix}`);
		act(`${why}: set ${name} aside as ${to}`, () => renameSync(`${conf}/${name}`, `${conf}/${to}`), `aside:${name}`);
	};
	return { conf, report, would, act, setAside };
}

/** The config directory's lock for a revert: none for a dry run, "busy" (said in `report.skipped`) when it is held. */
function lockForRevert(
	conf: string,
	o: { dryRun?: boolean; waitMs?: number },
	report: RevertReport,
): { release(): void } | undefined | "busy" {
	if (o.dryRun) return undefined;
	try {
		return holdFlock(conf, { waitMs: o.waitMs ?? 30_000 });
	} catch (e) {
		if (e instanceof FlockBusyError || e instanceof RelayLockUnavailableError) {
			report.skipped = `could not lock the config directory: ${e.message}`;
			return "busy";
		}
		throw e;
	}
}

/** The files a config document's `migrated.files` lists. */
function migratedList(d: Record<string, unknown> | undefined): string[] {
	const m = d?.migrated;
	return isObject(m) && Array.isArray(m.files) ? m.files.filter((x): x is string => typeof x === "string") : [];
}

/** The newest config.json.reverted, read ALWAYS, not only when there is no live config.json: a revert that crashed after setting config.json aside, then a
 * start that migrated the restored files again, leaves a live config.json whose list omits the secrets that are still in secrets/. */
function readReverted(conf: string, report: RevertReport): Record<string, unknown> | undefined {
	const revertedName = latestReverted(conf);
	if (!revertedName) return undefined;
	try {
		return JSON.parse(readFileSync(`${conf}/${revertedName}`, "utf8")) as Record<string, unknown>;
	} catch {
		report.problems.push(`${revertedName} is not readable: the secrets it lists cannot be moved back from it`);
		return undefined;
	}
}

/** The `<name>.migrated[.N]` archives in the directory, by the file they archive, for the non-secret files only. */
function archivesIn(conf: string): Map<string, { entry: string; n: number }[]> {
	let entries: string[] = [];
	try {
		entries = readdirSync(conf);
	} catch {
		// EMPTY_CATCH_OK: an unreadable config directory has nothing to restore; the lock above would have failed first.
	}
	const archives = new Map<string, { entry: string; n: number }[]>();
	for (const e of entries) {
		const m = /^(.+)\.migrated(?:\.(\d+))?$/.exec(e);
		const base = m?.[1];
		if (base !== undefined && Object.hasOwn(NON_SECRET_HOME, base))
			archives.set(base, [...(archives.get(base) ?? []), { entry: e, n: Number(m?.[2] ?? 0) }]);
	}
	return archives;
}

/** 1. The newest <name>.migrated of each non-secret file back to <name>; older archives are kept as <name>.earlier. True when a settings file was restored. */
function restoreArchives(rc: Reverter): boolean {
	let restoredSettings = false;
	for (const [base, list] of [...archivesIn(rc.conf)].sort(([a], [b]) => (a < b ? -1 : 1))) {
		list.sort((a, b) => a.n - b.n);
		const newest = list.pop();
		if (!newest) throw Error("revert: an archive group is never empty");
		for (const older of list) rc.setAside(older.entry, ".earlier", "an earlier archive");
		rc.setAside(base, ".reappeared", "written after the migration");
		rc.act(`restore ${base}`, () => renameSync(`${rc.conf}/${newest.entry}`, `${rc.conf}/${base}`), `restore:${base}`);
		if (!Object.hasOwn(LEGACY_THREAD_FILES_BY_NAME, base)) restoredSettings = true;
	}
	return restoredSettings;
}

/** One thread file carries config.json's current value for the member (a null means none: the file is set aside). */
function restoreThreadFile(rc: Reverter, member: string, file: string, t: unknown) {
	const p = `${rc.conf}/${file}`;
	if (t === null) {
		rc.setAside(file, ".pre-revert", `config.json says threads.${member} is none`);
		return;
	}
	if (typeof t !== "string" || !t.trim()) return;
	const now = existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
	if (now === t) return;
	if (now !== undefined) rc.setAside(file, ".pre-revert", `config.json's current threads.${member} replaces it`);
	rc.act(
		`write ${file} from config.json's current threads.${member}`,
		() => writeFileDurable(p, `${t}\n`),
		`thread:${file}`,
	);
}

/** 2. The thread files carry config.json's current values (only while config.json is live: after it is aside, the old layout is in charge). */
function restoreThreadFiles(rc: Reverter, rawThreads: unknown) {
	for (const [member, file] of Object.entries(LEGACY_THREAD_FILES)) {
		const t = rawThreads === null ? null : isObject(rawThreads) ? rawThreads[member] : undefined;
		restoreThreadFile(rc, member, file, t);
	}
}

/** 3. config.json goes aside: the restored files are now the layout. */
function setConfigAside(rc: Reverter, restoredSettings: boolean) {
	const { conf, report, act } = rc;
	const to = freeName(conf, `${CONFIG_FILE}.reverted`);
	act(`rename ${CONFIG_FILE} to ${to}`, () => renameSync(`${conf}/${CONFIG_FILE}`, `${conf}/${to}`), "config");
	if (restoredSettings)
		report.notes.push(
			`settings edited in config.json since the migration are NOT in the restored files; they are in ${to}`,
		);
}

/** 4. Each moved secret back to its old name. */
function moveSecretsBack(rc: Reverter, marker: string[]) {
	const { conf, act, setAside } = rc;
	for (const name of marker) {
		if (Object.hasOwn(NON_SECRET_HOME, name)) continue;
		const inSecrets = `${conf}/${SECRETS_DIR}/${name}`;
		if (!isLink(inSecrets) || lstatSync(inSecrets).isSymbolicLink()) continue;
		setAside(name, ".reappeared", "written after the migration");
		setAside(`${name}${MIGRATED_SUFFIX}`, ".earlier", "the link a symlinked secret left");
		act(
			`move ${SECRETS_DIR}/${name} back to ${name}`,
			() => renameSync(inSecrets, `${conf}/${name}`),
			`secret:${name}`,
		);
	}
}

/** The revert's steps, in the order that keeps every value readable at every crash point. The caller holds the lock. */
function revertSteps(conf: string, rc: Reverter) {
	const { report, would } = rc;
	const live = readConfigFile(conf);
	const reverted = readReverted(conf, report);
	const source: Record<string, unknown> | undefined = live ?? reverted; // the thread ids and the rest come from the live config when there is one
	// The moved secrets: the live config.json's list, the newest reverted one's, and any a crashed migration moved (its journal names them).
	const marker = [...new Set([...migratedList(live), ...migratedList(reverted), ...movedBeforeCrash(conf)])];
	const restoredSettings = restoreArchives(rc);
	if (live) restoreThreadFiles(rc, source?.threads);
	if (live) setConfigAside(rc, restoredSettings);
	moveSecretsBack(rc, marker);
	if (!would && existsSync(`${conf}/${JOURNAL}`)) rmSync(`${conf}/${JOURNAL}`, { force: true });
	if (!report.done.length && !live) report.done.push("nothing to revert");
	if (!would && report.done.length) syncDir(conf);
}

/**
 * Puts the old layout back so an older build starts again: the newest `<name>.migrated` of each file is renamed back, the three thread files are
 * written from config.json's CURRENT values (a Steward switch since the migration must not bring a retired Steward back; a thread set to null stays
 * none), each moved secret goes back to its old name, and config.json is renamed `config.json.reverted`. Nothing is ever replaced: anything already at
 * a name that revert needs is set aside under a free name first (`.reappeared`, `.pre-revert`, `.earlier`). Idempotent: a second run finds nothing to
 * do. The order keeps every value readable at every crash point: the files come back while config.json still serves them, config.json goes next (the
 * files are then read as the old layout), and the secrets go last (a secret is read from secrets/ until its rename, and from its old name after it). A
 * `config.json.reverted` left by a run that stopped after that step still says which secrets were moved: the newest one is read.
 */
export function revertLayout(
	conf: string,
	o: { dryRun?: boolean; waitMs?: number; afterStep?: AfterStep } = {},
): RevertReport {
	const report: RevertReport = { done: [], notes: [], problems: [] };
	const lock = lockForRevert(conf, o, report);
	if (lock === "busy") return report;
	try {
		revertSteps(conf, makeReverter(conf, report, o.dryRun === true, o.afterStep ?? (() => {})));
	} finally {
		lock?.release();
	}
	return report;
}

const LEGACY_THREAD_FILES_BY_NAME: Record<string, true> = Object.fromEntries(
	Object.values(LEGACY_THREAD_FILES).map((f) => [f, true as const]),
);
