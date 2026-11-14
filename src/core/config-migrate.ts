/**
 * Moves the old config directory (a file per setting) into the new layout (config.json and secrets/). The layout is described in
 * src/core/layout.ts; the old-to-new map for every file and variable is docs/config-migration.md.
 *
 * It MOVES; it does not copy, because a stale old file is read by tools outside Chamberlain (the Steward's hand-off read `steward-thread`),
 * and after a Steward switch it would name a retired Steward. The order is what makes a crash safe:
 *
 *   1. each secret is renamed into `secrets/<same name>` (atomic, keeps its mtime, leaves one copy);
 *   2. config.json is written (atomically), with a `migrated.files` list of everything moved or about to be;
 *   3. only then is each migrated non-secret file renamed `<name>.migrated`.
 *
 * A crash after any step leaves every value readable: a moved secret is read from secrets/ first; a file not yet renamed is ignored once
 * config.json lists it (config.json holds its value) and renamed by the next run. `planMigration` says what would happen without doing it;
 * `migrateLayout` does it under a `flock(2)` on the config directory. It is idempotent and never overwrites: a key config.json already holds
 * wins, a secret already in secrets/ wins, and a difference is reported, not resolved. `revertLayout` undoes it.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { isPrivateFile, modeText } from "./private.ts";
import {
	CONFIG_FILE,
	ENV_KEYS,
	LEGACY_THREAD_FILES,
	SCALARS,
	SECRETS_DIR,
	THREADS,
	MIGRATED_SUFFIX,
	NON_SECRET_HOME,
	SECRET_FILE,
	attachDeprecationLog,
	ensureSecretsDir,
	legacyValue,
	migratedNames,
	oldFileState,
	parseConfigDoc,
	readConfigFile,
	reappeared,
	reappearedFiles,
	syncDir,
	writeConfigFile,
	writeFileDurable,
	type ScalarKey,
	type ThreadKey,
} from "./layout.ts";
import { FlockBusyError, holdFlock, RelayLockUnavailableError } from "./singleton.ts";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pure: JSON with the keys sorted, so two values compare equal whatever the order they were written in. */
const canonical = (v: unknown): string =>
	JSON.stringify(v, (_k, x) =>
		isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
	);

/** Every key that came from the old settings.json, in the order they are written. */
const SETTINGS_KEYS = ["principal", "t3Dir", "t3StateDb", "alertCmd", "compactTokens", "settledMatch"];
/** Sections that each came from one old file (the thread ids are handled apart). */
const FILE_SECTIONS = ["servers", "web", "sweep", "alertDesk", "operatingRules", "judge"];
/** Files that stay files: prose the operator edits, and systemd's environment file. */
const STAYS = [
	"decision-rights.md",
	"sweep-prompt.md",
	"alert-desk-prompt.md",
	"operating-rules.md",
	"brief.d",
	"daemon.env",
];

/** Written before the first secret moves and removed once config.json is on disk: it names the secrets a crashed run may have moved. */
const JOURNAL = ".config-migrating";

/** The secrets the journal names that are now in secrets/ and gone from their old name: moved by a run that crashed before it wrote config.json. */
function movedBeforeCrash(conf: string): string[] {
	try {
		const j = JSON.parse(readFileSync(`${conf}/${JOURNAL}`, "utf8")) as { secrets?: unknown };
		return (Array.isArray(j.secrets) ? j.secrets : []).filter(
			(n): n is string =>
				typeof n === "string" && existsSync(`${conf}/${SECRETS_DIR}/${n}`) && !existsSync(`${conf}/${n}`),
		);
	} catch {
		return []; // no journal, or one that is not readable: nothing to add
	}
}

export type Plan = {
	/** The document config.json would hold after the migration. */
	config: Record<string, unknown>;
	/** True when config.json has to be written (it is new, or a key is added). */
	writeConfig: boolean;
	/** Keys added to config.json and the old file or variable each came from. */
	added: { key: string; from: string }[];
	/** Keys both config.json and an old file hold with different values: config.json wins, nothing is changed. */
	differs: { key: string; from: string }[];
	/** Each secret and what is done with it: `move` it into secrets/, or leave it (`present`/`differs`: secrets/ already holds it; `skip`). */
	secrets: { name: string; action: "move" | "present" | "differs" | "skip"; why?: string }[];
	/** Non-secret old files to rename `<name>.migrated` after config.json is on disk. */
	renames: string[];
	/** What stopped something from being migrated: a file that could not be read or is not private enough. The rest still is. */
	problems: string[];
	notes: string[];
	/** The files that stay files, as they are present. */
	stays: string[];
	/** Old files at their old place that were never migrated, so are still read as a fallback (a problem stopped them being moved). */
	leftovers: string[];
	/** Old names at their old place that a migration moved and something wrote again: never read. */
	reappeared: string[];
};

/** Pure: the `KEY=value` lines of a systemd EnvironmentFile as pairs, quotes stripped, comments and blank lines dropped. */
export function parseEnvFile(text: string): [string, string][] {
	const out: [string, string][] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2]!.trim();
		if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
			v = v.slice(1, -1);
		out.push([m[1]!, v]);
	}
	return out;
}

/** Pure: an environment value as the typed value its key takes, or undefined when it is not usable. */
export function envValue(key: ScalarKey, raw: string): unknown {
	const kind = SCALARS[key] as string;
	if (kind === "string") return raw.trim() ? raw : undefined;
	if (kind === "boolean") return raw === "1" ? true : raw === "0" ? false : undefined;
	if (kind === "list") {
		const l = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return l.length ? l : undefined;
	}
	const n = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(n)) return undefined;
	if (kind === "posnum" && n <= 0) return undefined;
	if (kind === "nonneg" && n < 0) return undefined;
	if (kind === "posint" && (!Number.isInteger(n) || n < 1)) return undefined;
	return n;
}

/** The secret names a plan covers: the fixed ones, every `*-token` file, and every token file the config names. */
function secretNames(conf: string, doc: Record<string, unknown>): string[] {
	const names = new Set<string>();
	const add = (v: unknown) => {
		if (typeof v === "string" && v.trim()) names.add(v.trim());
	};
	for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
		if (isObject(s)) {
			add(s.tokenFile);
			add(s.operateTokenFile);
		}
	}
	const web = isObject(doc.web) ? doc.web : {};
	if (isObject(web.decisionsServer)) add(web.decisionsServer.operateTokenFile);
	if (isObject(web.answerTokens)) for (const v of Object.values(web.answerTokens)) add(v);
	try {
		for (const e of readdirSync(conf, { withFileTypes: true }))
			if ((e.isFile() || e.isSymbolicLink()) && SECRET_FILE.test(e.name)) names.add(e.name);
	} catch {
		// EMPTY_CATCH_OK: an unreadable config directory has no files to find; the caller reports the directory itself.
	}
	return [...names].filter((n) => n && !n.startsWith("/") && !n.split("/").includes(".."));
}

/** What a migration of `conf` would do. Reads only; never prints a value. */
export function planMigration(conf: string): Plan {
	const existing = readConfigFile(conf);
	const doc: Record<string, unknown> = existing ? { ...existing } : {};
	if (isObject(doc.threads)) doc.threads = { ...doc.threads };
	const plan: Plan = {
		config: doc,
		writeConfig: !existing,
		added: [],
		differs: [],
		secrets: [],
		problems: [],
		notes: [],
		stays: STAYS.filter((n) => existsSync(`${conf}/${n}`)),
		leftovers: [],
		reappeared: [],
		renames: [],
	};
	const fold = (key: string, from: string, value: unknown, trust?: string) => {
		if (trust) {
			plan.problems.push(
				`${from}: ${trust}. It is not migrated, because config.json is trusted and this file was not: fix the file (or move its contents into config.json yourself) and run again`,
			);
			return;
		}
		if (Object.hasOwn(doc, key)) {
			if (canonical(doc[key]) !== canonical(value)) plan.differs.push({ key, from });
			return;
		}
		doc[key] = value;
		plan.added.push({ key, from });
	};
	const legacy = (key: string) => {
		try {
			return legacyValue(conf, key);
		} catch (e) {
			plan.problems.push(String((e as Error).message ?? e).slice(0, 300));
			return undefined;
		}
	};

	try {
		const p = `${conf}/settings.json`;
		if (oldFileState(conf, "settings.json", false) === "usable" && isPrivateFile(statSync(p))) {
			const known = new Set([
				"schemaVersion",
				"principalName",
				"t3BaseDir",
				"t3StateDb",
				"alertCommand",
				"compactTokens",
				"settledMatch",
			]);
			const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
			const extra = isObject(raw) ? Object.keys(raw).filter((k) => !known.has(k)) : [];
			if (extra.length)
				plan.notes.push(
					`settings.json: ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not read by this build, so not migrated`,
				);
		}
	} catch {
		// EMPTY_CATCH_OK: a settings.json that cannot be read is reported by the migration of its keys just below.
	}
	for (const key of [...SETTINGS_KEYS, ...FILE_SECTIONS]) {
		const v = legacy(key);
		if (v) fold(key, v.file, v.value, v.trust);
	}
	const threadsNone = existing !== undefined && Object.hasOwn(existing, "threads") && existing.threads === null;
	for (const member of threadsNone ? [] : THREADS) {
		let id: string | undefined;
		try {
			id = legacyThreadId(conf, member);
		} catch (e) {
			plan.problems.push(String((e as Error).message ?? e).slice(0, 300));
		}
		if (!id) continue;
		const t = (isObject(doc.threads) ? doc.threads : (doc.threads = {})) as Record<string, unknown>;
		if (Object.hasOwn(t, member)) {
			if (t[member] !== id) plan.differs.push({ key: `threads.${member}`, from: LEGACY_THREAD_FILES[member] });
		} else {
			t[member] = id;
			plan.added.push({ key: `threads.${member}`, from: LEGACY_THREAD_FILES[member] });
		}
	}

	// daemon.env is systemd's own file and stays; the settings in it that have a key are copied, so config.json holds them when it is removed.
	const envFile = `${conf}/daemon.env`;
	if (existsSync(envFile)) {
		if (!isPrivateFile(statSync(envFile))) {
			plan.problems.push("daemon.env: not read, because it is not a private regular file (mode exactly 0600)");
		} else {
			let others = 0;
			for (const [name, raw] of parseEnvFile(readFileSync(envFile, "utf8"))) {
				const key = ENV_KEYS[name];
				if (!key) {
					others++;
					continue;
				}
				const v = envValue(key, raw);
				if (v === undefined) {
					plan.notes.push(`daemon.env: ${name} holds a value this build cannot use; not copied`);
					continue;
				}
				if (Object.hasOwn(doc, key) && canonical(doc[key]) !== canonical(v)) {
					plan.differs.push({ key, from: `daemon.env ${name}` });
					continue;
				}
				if (!Object.hasOwn(doc, key)) {
					doc[key] = v;
					plan.added.push({ key, from: `daemon.env ${name}` });
				}
			}
			if (others)
				plan.notes.push(
					`daemon.env: ${others} other variable${others === 1 ? "" : "s"} stay${others === 1 ? "s" : ""} there`,
				);
		}
	}

	for (const name of secretNames(conf, doc)) {
		const from = `${conf}/${name}`;
		const to = `${conf}/${SECRETS_DIR}/${name}`;
		let st: Stats | undefined;
		try {
			st = statSync(from);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		const there = existsSync(to);
		if (!st) {
			if (!there)
				plan.notes.push(`${name}: named by the config, but there is no such file in secrets/ or the config directory`);
			continue;
		}
		if (!st.isFile()) {
			plan.secrets.push({ name, action: "skip", why: "not a regular file" });
			continue;
		}
		const state = oldFileState(conf, name, true);
		if (state === "reappeared") {
			// Moved by an earlier migration and written again at the old name: never read, never moved over the one in secrets/.
			if (there) {
				const same = readFileSync(from).equals(readFileSync(to));
				plan.secrets.push({
					name,
					action: same ? "present" : "differs",
					why: `an old file written after the move; secrets/${name} is the one read${same ? " (the two are the same)" : " (the two differ)"}`,
				});
			} else
				plan.secrets.push({
					name,
					action: "skip",
					why: "moved by an earlier migration and now gone from secrets/: not moved back",
				});
			continue;
		}
		if (!isPrivateFile(st)) {
			plan.secrets.push({
				name,
				action: "skip",
				why: `mode ${modeText(st.mode)}, not 0600: chmod 600 it and run again`,
			});
			plan.problems.push(`${name}: not moved, because it is not mode exactly 0600`);
			continue;
		}
		if (there) {
			const same = readFileSync(from).equals(readFileSync(to));
			plan.secrets.push({
				name,
				action: same ? "present" : "differs",
				...(same ? {} : { why: "secrets/ already holds a different value; it wins" }),
			});
		} else plan.secrets.push({ name, action: "move" });
	}

	// Non-secret files to rename: every file a key came from this run, and any a crash left migrated but not yet renamed.
	const fileNames = new Set(
		plan.added.map((a) => a.from.split(" ")[0]!).filter((f) => Object.hasOwn(NON_SECRET_HOME, f)),
	);
	for (const f of Object.keys(NON_SECRET_HOME)) if (oldFileState(conf, f, false) === "pending") fileNames.add(f);
	plan.renames = [...fileNames];
	// Secrets an earlier run moved before it crashed (the journal names them): they belong in the list too, so `revert` can move them back.
	const earlier = movedBeforeCrash(conf);
	const moved = [...plan.secrets.filter((s) => s.action === "move").map((s) => s.name), ...earlier];
	if (plan.added.length + moved.length + plan.renames.length > 0) {
		const m = isObject(doc.migrated) ? doc.migrated : {};
		const had = Array.isArray(m.files) ? (m.files as string[]) : [];
		const files = [...new Set([...had, ...moved, ...plan.renames])];
		if (files.length !== had.length || !isObject(doc.migrated)) {
			doc.migrated = { at: typeof m.at === "string" ? m.at : new Date().toISOString(), files };
			plan.writeConfig = true;
		}
	}
	if (plan.added.length) plan.writeConfig = true;
	plan.reappeared = reappearedFiles(conf);
	plan.leftovers = [
		...Object.keys(NON_SECRET_HOME).filter(
			(f) => oldFileState(conf, f, false) === "usable" && !plan.renames.includes(f),
		),
		...plan.secrets
			.filter((s) => s.action === "skip" && oldFileState(conf, s.name, true) === "usable")
			.map((s) => s.name),
	];
	return plan;
}

function legacyThreadId(conf: string, member: ThreadKey): string | undefined {
	const name = LEGACY_THREAD_FILES[member];
	const p = `${conf}/${name}`;
	// Only a file that was never migrated: one a migration moved and something wrote again is never read, here or anywhere.
	if (oldFileState(conf, name, false) !== "usable") return undefined;
	const st = statSync(p);
	if (!isPrivateFile(st))
		throw Error(`${name} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
	return readFileSync(p, "utf8").trim() || undefined;
}

export type Result = {
	plan: Plan;
	/** True when something was written. */
	changed: boolean;
	/** Why nothing was written, when the lock could not be taken. */
	skipped?: string;
};

/** A test seam: called after each step completes (`secret:<name>`, `config`, `rename:<file>`). A test that throws from it is a crash at that point. */
export type AfterStep = (step: string) => void;

/** A name for `<file>.migrated` that is free: the plain one, or the plain one with a counter when an earlier migration left one. */
function freeMigratedName(conf: string, f: string): string {
	let n = `${f}${MIGRATED_SUFFIX}`;
	for (let i = 1; existsSync(`${conf}/${n}`); i++) n = `${f}${MIGRATED_SUFFIX}.${i}`;
	return n;
}

/**
 * Does what `plan` says, in the order that makes a crash safe (see the top of this file): the secrets, then config.json, then the renames.
 * The caller holds the lock.
 */
function apply(conf: string, plan: Plan, after: AfterStep = () => {}): boolean {
	let changed = false;
	// A symlink is resolved first: if it points at another secret, that secret must still be where it points when the link's content is read.
	const linkFirst = (n: string) => (lstatSync(`${conf}/${n}`).isSymbolicLink() ? 0 : 1);
	const moves = plan.secrets.filter((s) => s.action === "move").sort((a, b) => linkFirst(a.name) - linkFirst(b.name));
	if (moves.length) {
		ensureSecretsDir(conf);
		chmodSync(`${conf}/${SECRETS_DIR}`, 0o700);
		writeFileDurable(`${conf}/${JOURNAL}`, `${JSON.stringify({ secrets: moves.map((m) => m.name) })}\n`);
	}
	for (const s of moves) {
		const from = `${conf}/${s.name}`;
		const to = `${conf}/${SECRETS_DIR}/${s.name}`;
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		if (lstatSync(from).isSymbolicLink()) {
			// A symlink cannot be moved as a secret (it would point at nothing from secrets/): its content is written under the secret's name,
			// keeping the target's date, and the link itself is set aside as <name>.migrated.
			const target = statSync(from);
			const tmp = `${to}.tmp-${process.pid}`;
			rmSync(tmp, { force: true });
			copyFileSync(from, tmp);
			chmodSync(tmp, 0o600);
			utimesSync(tmp, target.atime, target.mtime);
			renameSync(tmp, to);
			renameSync(from, `${conf}/${freeMigratedName(conf, s.name)}`);
		} else {
			renameSync(from, to); // atomic; the mtime goes with it (the token-age alarm reads it), and one copy is left
		}
		changed = true;
		after(`secret:${s.name}`);
	}
	if (moves.length) {
		syncDir(`${conf}/${SECRETS_DIR}`);
		syncDir(conf);
	}
	if (plan.writeConfig) {
		parseConfigDoc(plan.config);
		writeConfigFile(conf, plan.config); // flushed, then the directory: config.json is on disk before any file is set aside
		rmSync(`${conf}/${JOURNAL}`, { force: true });
		changed = true;
		after("config");
	}
	// Only now, with config.json safely on disk, are the non-secret files set aside.
	for (const f of plan.renames) {
		if (!existsSync(`${conf}/${f}`)) continue;
		renameSync(`${conf}/${f}`, `${conf}/${freeMigratedName(conf, f)}`);
		changed = true;
		after(`rename:${f}`);
	}
	if (plan.renames.length) syncDir(conf);
	return changed;
}

/**
 * Migrates `conf` (or, with `dryRun`, only plans it). Takes the config directory's lock for the write, waiting up to `waitMs`; a lock that
 * cannot be had, or a platform without `flock`, is reported in `skipped` and nothing is written.
 */
export function migrateLayout(
	conf: string,
	o: { dryRun?: boolean; waitMs?: number; afterStep?: AfterStep } = {},
): Result {
	if (o.dryRun) return { plan: planMigration(conf), changed: false };
	let lock: { release(): void };
	try {
		lock = holdFlock(conf, { waitMs: o.waitMs ?? 30_000 });
	} catch (e) {
		if (e instanceof FlockBusyError || e instanceof RelayLockUnavailableError)
			return {
				plan: planMigration(conf),
				changed: false,
				skipped: `could not lock the config directory: ${e.message}`,
			};
		throw e;
	}
	try {
		const plan = planMigration(conf);
		return { plan, changed: apply(conf, plan, o.afterStep) };
	} finally {
		lock.release();
	}
}

/**
 * Changes config.json under the config directory's lock. A config directory that is still the old layout is migrated first, so nothing the old
 * files held is lost by writing a config.json that only has the change in it.
 */
export function updateConfig(conf: string, mutate: (doc: Record<string, unknown>) => void): void {
	const lock = holdFlock(conf, { waitMs: 10_000 });
	try {
		if (!existsSync(`${conf}/${CONFIG_FILE}`)) {
			const plan = planMigration(conf);
			apply(conf, plan);
		}
		const doc = { ...(readConfigFile(conf) ?? {}) };
		mutate(doc);
		parseConfigDoc(doc);
		writeConfigFile(conf, doc);
	} finally {
		lock.release();
	}
}

/** Sets a thread id in config.json (`threads.<member>`). */
export function setThread(conf: string, member: ThreadKey, id: string): void {
	updateConfig(conf, (doc) => {
		doc.threads = { ...(isObject(doc.threads) ? doc.threads : {}), [member]: id };
	});
}

// ---- revert ----------------------------------------------------------------------------------------------

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
	let lock: { release(): void } | undefined;
	if (!o.dryRun) {
		try {
			lock = holdFlock(conf, { waitMs: o.waitMs ?? 30_000 });
		} catch (e) {
			if (e instanceof FlockBusyError || e instanceof RelayLockUnavailableError) {
				report.skipped = `could not lock the config directory: ${e.message}`;
				return report;
			}
			throw e;
		}
	}
	const would = o.dryRun === true;
	const after = o.afterStep ?? (() => {});
	const act = (line: string, fn: () => void, step: string) => {
		report.done.push(`${would ? "would " : ""}${line}`);
		if (would) return;
		fn();
		after(step);
	};
	/** Sets whatever is at `name` aside under a free name, so the next step can use `name`. */
	const setAside = (name: string, suffix: string, why: string) => {
		if (!isLink(`${conf}/${name}`)) return;
		const to = freeName(conf, `${name}${suffix}`);
		act(`${why}: set ${name} aside as ${to}`, () => renameSync(`${conf}/${name}`, `${conf}/${to}`), `aside:${name}`);
	};
	try {
		const live = readConfigFile(conf);
		let source: Record<string, unknown> | undefined = live;
		if (!source) {
			const reverted = latestReverted(conf);
			if (reverted) {
				try {
					source = JSON.parse(readFileSync(`${conf}/${reverted}`, "utf8")) as Record<string, unknown>;
				} catch {
					report.problems.push(`${reverted} is not readable: the moved secrets cannot be listed from it`);
				}
			}
		}
		// The moved secrets: config.json's list, plus any a crashed migration moved before it wrote config.json (its journal names them).
		const marker = [
			...(isObject(source?.migrated) && Array.isArray((source?.migrated as { files?: unknown }).files)
				? (source?.migrated as { files: unknown[] }).files.filter((x): x is string => typeof x === "string")
				: []),
			...movedBeforeCrash(conf),
		];
		const rawThreads = source?.threads;

		// 1. the newest <name>.migrated of each non-secret file back to <name>; older archives are kept as <name>.earlier
		let entries: string[] = [];
		try {
			entries = readdirSync(conf);
		} catch {
			// EMPTY_CATCH_OK: an unreadable config directory has nothing to restore; the lock above would have failed first.
		}
		const archives = new Map<string, { entry: string; n: number }[]>();
		for (const e of entries) {
			const m = /^(.+)\.migrated(?:\.(\d+))?$/.exec(e);
			if (m && Object.hasOwn(NON_SECRET_HOME, m[1]!))
				archives.set(m[1]!, [...(archives.get(m[1]!) ?? []), { entry: e, n: Number(m[2] ?? 0) }]);
		}
		let restoredSettings = false;
		for (const [base, list] of [...archives].sort(([a], [b]) => (a < b ? -1 : 1))) {
			list.sort((a, b) => a.n - b.n);
			const newest = list.pop()!;
			for (const older of list) setAside(older.entry, ".earlier", "an earlier archive");
			setAside(base, ".reappeared", "written after the migration");
			act(`restore ${base}`, () => renameSync(`${conf}/${newest.entry}`, `${conf}/${base}`), `restore:${base}`);
			if (!Object.hasOwn(LEGACY_THREAD_FILES_BY_NAME, base)) restoredSettings = true;
		}
		// 2. the thread files carry config.json's current values (only while config.json is live: after it is aside, the old layout is in charge)
		if (live) {
			for (const [member, file] of Object.entries(LEGACY_THREAD_FILES)) {
				const t = rawThreads === null ? null : isObject(rawThreads) ? rawThreads[member] : undefined;
				const p = `${conf}/${file}`;
				if (t === null) {
					setAside(file, ".pre-revert", `config.json says threads.${member} is none`);
					continue;
				}
				if (typeof t !== "string" || !t.trim()) continue;
				const now = existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
				if (now === t) continue;
				if (now !== undefined) setAside(file, ".pre-revert", `config.json's current threads.${member} replaces it`);
				act(
					`write ${file} from config.json's current threads.${member}`,
					() => writeFileDurable(p, `${t}\n`),
					`thread:${file}`,
				);
			}
		}
		// 3. config.json goes aside: the restored files are now the layout
		if (live) {
			const to = freeName(conf, `${CONFIG_FILE}.reverted`);
			act(`rename ${CONFIG_FILE} to ${to}`, () => renameSync(`${conf}/${CONFIG_FILE}`, `${conf}/${to}`), "config");
			if (restoredSettings)
				report.notes.push(
					`settings edited in config.json since the migration are NOT in the restored files; they are in ${to}`,
				);
		}
		// 4. each moved secret back to its old name
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
		if (!would && existsSync(`${conf}/${JOURNAL}`)) rmSync(`${conf}/${JOURNAL}`, { force: true });
		if (!report.done.length && !live) report.done.push("nothing to revert");
		if (!would && report.done.length) syncDir(conf);
	} finally {
		lock?.release();
	}
	return report;
}

const LEGACY_THREAD_FILES_BY_NAME: Record<string, true> = Object.fromEntries(
	Object.values(LEGACY_THREAD_FILES).map((f) => [f, true as const]),
);

/**
 * What the daemon and the page do at every start. A config directory with old files and no config.json is migrated, with one `config-migrated`
 * line; a migration a crash cut short (config.json written, files not yet renamed) is finished. Old files a migration moved and something wrote
 * again are noticed once each as `config-legacy-reappeared` and never read. Files that could not be migrated (a problem stopped them) are listed in
 * `config-legacy-files`: they are still read as a fallback. A migration that cannot run (a lock held, a read-only directory) is logged as
 * `config-migrate-failed` and the old files keep being read.
 */
export function startupLayout(conf: string, log: (event: string, data?: Record<string, unknown>) => void): void {
	attachDeprecationLog(log);
	const first = !existsSync(`${conf}/${CONFIG_FILE}`);
	try {
		const probe = planMigration(conf);
		const todo = first ? probe.added.length + probe.secrets.filter((s) => s.action === "move").length : 0;
		if (todo || probe.renames.length) {
			const result = migrateLayout(conf);
			if (result.skipped) log("config-migrate-failed", { why: result.skipped });
			else if (result.changed)
				log("config-migrated", {
					keys: result.plan.added.map((a) => a.key),
					secrets: result.plan.secrets.filter((s) => s.action === "move").map((s) => s.name),
					renamed: result.plan.renames.map((f) => `${f}${MIGRATED_SUFFIX}`),
					problems: result.plan.problems,
					note: "old files were moved, not copied; see docs/config-migration.md. `chamberlain config revert` puts them back",
				});
		}
	} catch (e) {
		log("config-migrate-failed", { why: String((e as Error).message ?? e).slice(0, 300) });
	}
	try {
		const left = planMigration(conf);
		for (const f of left.reappeared) reappeared(conf, f);
		if (left.leftovers.length)
			log("config-legacy-files", {
				files: left.leftovers,
				note: "these were not migrated, so they are still read where config.json lacks the key. Fix what `config migrate` reports, then run it again",
			});
		for (const p of left.problems) log("config-migrate-problem", { problem: p });
	} catch (e) {
		log("config-migrate-failed", { why: String((e as Error).message ?? e).slice(0, 300) });
	}
}
