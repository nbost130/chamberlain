/**
 * Converts the old config directory (a file per setting) into the new layout (config.json and secrets/), and leaves the old files where they
 * are. The layout is described in src/core/layout.ts; the old-to-new map for every file and variable is docs/config-migration.md.
 *
 * `planMigration` reads the old files and says what it would do, without doing it; `migrateLayout` does it under a `flock(2)` on the config
 * directory (so the daemon and the page, starting together, cannot both write). It is idempotent and never overwrites: a key config.json
 * already holds wins, a secret already in secrets/ wins, and a difference is reported, not resolved. The secrets are copied first and
 * config.json is written last, so a run that stops half way leaves the old layout fully in use and the next run finishes it.
 */
import {
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
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
	ensureSecretsDir,
	legacyFilesPresent,
	legacyValue,
	parseConfigDoc,
	readConfigFile,
	writeConfigFile,
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
/**
 * A secret file of the old layout, by its name: a token (`*-token`) or a webhook URL (`*-url`, and the `.steward` / `.prev` copies a hand-off
 * makes). A file the config names as a token file is a secret as well, whatever it is called.
 */
const SECRET_FILE = /(^|-)(token|url)(\.[A-Za-z]+)?$/;
/** Files that stay files: prose the operator edits, and systemd's environment file. */
const STAYS = [
	"decision-rights.md",
	"sweep-prompt.md",
	"alert-desk-prompt.md",
	"operating-rules.md",
	"brief.d",
	"daemon.env",
];

export type Plan = {
	/** The document config.json would hold after the migration. */
	config: Record<string, unknown>;
	/** True when config.json has to be written (it is new, or a key is added). */
	writeConfig: boolean;
	/** Keys added to config.json and the old file or variable each came from. */
	added: { key: string; from: string }[];
	/** Keys both config.json and an old file hold with different values: config.json wins, nothing is changed. */
	differs: { key: string; from: string }[];
	secrets: { name: string; action: "copy" | "present" | "differs" | "skip"; why?: string }[];
	/** What stopped something from being migrated: a file that could not be read or is not private enough. The rest still is. */
	problems: string[];
	notes: string[];
	/** The files that stay files, as they are present. */
	stays: string[];
	/** Old files still on disk after the migration; every one is safe to delete once `config show` reads right. */
	leftovers: string[];
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
		if (existsSync(p) && isPrivateFile(statSync(p))) {
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
		if (!isPrivateFile(st)) {
			plan.secrets.push({
				name,
				action: "skip",
				why: `mode ${modeText(st.mode)}, not 0600: chmod 600 it and run again`,
			});
			plan.problems.push(`${name}: not copied, because it is not mode exactly 0600`);
			continue;
		}
		if (there) {
			const same = readFileSync(from).equals(readFileSync(to));
			plan.secrets.push({
				name,
				action: same ? "present" : "differs",
				...(same ? {} : { why: "secrets/ already holds a different value; it wins" }),
			});
		} else plan.secrets.push({ name, action: "copy" });
	}

	const files = [
		...new Set([
			...plan.added.map((a) => a.from.split(" ")[0]!),
			...plan.secrets.filter((s) => s.action === "copy").map((s) => s.name),
		]),
	];
	if (files.length && plan.added.length + plan.secrets.filter((s) => s.action === "copy").length > 0) {
		const m = isObject(doc.migrated) ? doc.migrated : {};
		const had = Array.isArray(m.files) ? (m.files as string[]) : [];
		doc.migrated = {
			at: typeof m.at === "string" ? m.at : new Date().toISOString(),
			files: [...new Set([...had, ...files])],
		};
	}
	if (plan.added.length) plan.writeConfig = true;
	plan.leftovers = [...legacyFilesPresent(conf), ...plan.secrets.filter((s) => s.action !== "skip").map((s) => s.name)];
	return plan;
}

function legacyThreadId(conf: string, member: ThreadKey): string | undefined {
	const name = LEGACY_THREAD_FILES[member];
	const p = `${conf}/${name}`;
	if (!existsSync(p)) return undefined;
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

/** Does what `plan` says: the secrets first, config.json last. The caller holds the lock. */
function apply(conf: string, plan: Plan): boolean {
	let changed = false;
	const copies = plan.secrets.filter((s) => s.action === "copy");
	if (copies.length) {
		ensureSecretsDir(conf);
		chmodSync(`${conf}/${SECRETS_DIR}`, 0o700);
		for (const s of copies) {
			const to = `${conf}/${SECRETS_DIR}/${s.name}`;
			mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
			// Through a temporary file and a rename, so a copy that is cut short leaves no half-written secret under its real name to be
			// taken, on the next run, for the one that wins.
			const tmp = `${to}.tmp-${process.pid}`;
			rmSync(tmp, { force: true });
			copyFileSync(`${conf}/${s.name}`, tmp, constants.COPYFILE_EXCL);
			chmodSync(tmp, 0o600);
			renameSync(tmp, to);
			changed = true;
		}
	}
	if (plan.writeConfig) {
		parseConfigDoc(plan.config);
		writeConfigFile(conf, plan.config);
		changed = true;
	}
	return changed;
}

/**
 * Migrates `conf` (or, with `dryRun`, only plans it). Takes the config directory's lock for the write, waiting up to `waitMs`; a lock that
 * cannot be had, or a platform without `flock`, is reported in `skipped` and nothing is written.
 */
export function migrateLayout(conf: string, o: { dryRun?: boolean; waitMs?: number } = {}): Result {
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
		return { plan, changed: apply(conf, plan) };
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

/**
 * What the daemon and the page do at every start. A config directory with old files and no config.json is migrated, with one `config-migrated`
 * line; old files still there afterwards are listed once in `config-legacy-files`, so nobody edits one and wonders why nothing changed. A
 * migration that cannot run (a lock held, a read-only directory) is logged as `config-migrate-failed` and the old files keep being read.
 */
export function startupLayout(conf: string, log: (event: string, data?: Record<string, unknown>) => void): void {
	const first = !existsSync(`${conf}/${CONFIG_FILE}`);
	let result: Result | undefined;
	try {
		const probe = planMigration(conf);
		if (first && (probe.added.length || probe.secrets.some((s) => s.action === "copy"))) {
			result = migrateLayout(conf);
			if (result.skipped) log("config-migrate-failed", { why: result.skipped });
			else if (result.changed)
				log("config-migrated", {
					keys: result.plan.added.map((a) => a.key),
					secrets: result.plan.secrets.filter((s) => s.action === "copy").map((s) => s.name),
					problems: result.plan.problems,
					note: "old files are left where they are; see docs/config-migration.md",
				});
		}
	} catch (e) {
		log("config-migrate-failed", { why: String((e as Error).message ?? e).slice(0, 300) });
	}
	try {
		const left = planMigration(conf);
		if (left.leftovers.length)
			log("config-legacy-files", {
				files: left.leftovers,
				note: "config.json and secrets/ win; a key or secret missing there is still read from these files. Delete them once `chamberlain config show` reads right",
			});
		for (const p of left.problems) log("config-migrate-problem", { problem: p });
	} catch (e) {
		log("config-migrate-failed", { why: String((e as Error).message ?? e).slice(0, 300) });
	}
}
