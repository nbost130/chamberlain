/** What a migration of the old config directory would do (planMigration): reads only, never prints a value. */
import type { Stats } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
	foldDaemonEnv,
	foldLegacyKeys,
	foldThreadIds,
	isObject,
	noteUnreadSettings,
	type PlanCtx,
} from "./config-fold.ts";
import { readConfigFile } from "./layout.ts";
import { NON_SECRET_HOME, oldFileState, readJournal, reappearedFiles, SECRET_FILE } from "./layout-legacy.ts";
import { SECRETS_DIR } from "./layout-schema.ts";
import { isPrivateFile, modeText } from "./private.ts";

/** Files that stay files: prose the operator edits, and systemd's environment file. */
const STAYS = [
	"decision-rights.md",
	"sweep-prompt.md",
	"alert-desk-prompt.md",
	"operating-rules.md",
	"brief.d",
	"daemon.env",
];

/** The secrets the journal names that are now in secrets/: moved by a run that crashed before it wrote config.json. (A symlink still at its old name counts: its copy is done.) */
export function movedBeforeCrash(conf: string): string[] {
	return readJournal(conf).secrets.filter((n) => existsSync(`${conf}/${SECRETS_DIR}/${n}`));
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

/** The token files the config names: each server's read and operate token, the Decisions server's, and every answer token. */
function namedTokenFiles(doc: Record<string, unknown>): unknown[] {
	const named: unknown[] = [];
	for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
		if (isObject(s)) named.push(s.tokenFile, s.operateTokenFile);
	}
	const web = isObject(doc.web) ? doc.web : {};
	if (isObject(web.decisionsServer)) named.push(web.decisionsServer.operateTokenFile);
	if (isObject(web.answerTokens)) named.push(...Object.values(web.answerTokens));
	return named;
}

/** The secret names a plan covers: the fixed ones, every `*-token` file, and every token file the config names. */
function secretNames(conf: string, doc: Record<string, unknown>): string[] {
	const names = new Set<string>();
	for (const v of namedTokenFiles(doc)) if (typeof v === "string" && v.trim()) names.add(v.trim());
	try {
		for (const e of readdirSync(conf, { withFileTypes: true }))
			if ((e.isFile() || e.isSymbolicLink()) && SECRET_FILE.test(e.name)) names.add(e.name);
	} catch {
		// EMPTY_CATCH_OK: an unreadable config directory has no files to find; the caller reports the directory itself.
	}
	return [...names].filter((n) => n && !n.startsWith("/") && !n.split("/").includes(".."));
}

/** The file's stat, or undefined when it is not there. */
function statIfPresent(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return undefined;
	}
}

/** A secret an earlier migration moved that was written again at its old name: never read, never moved over the one in secrets/. */
function planReappearedSecret(
	plan: Plan,
	name: string,
	{ from, to, there }: { from: string; to: string; there: boolean },
) {
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
}

/** What to do with one secret: move it, leave it (secrets/ holds it), or skip it with the reason. */
function planSecret({ conf, plan }: PlanCtx, name: string) {
	const from = `${conf}/${name}`;
	const to = `${conf}/${SECRETS_DIR}/${name}`;
	const st = statIfPresent(from);
	const there = existsSync(to);
	if (!st) {
		if (!there)
			plan.notes.push(`${name}: named by the config, but there is no such file in secrets/ or the config directory`);
		return;
	}
	if (!st.isFile()) {
		plan.secrets.push({ name, action: "skip", why: "not a regular file" });
		return;
	}
	const state = oldFileState(conf, name, true);
	if (state === "reappeared" && there && lstatSync(from).isSymbolicLink() && readJournal(conf).secrets.includes(name)) {
		// A crashed run copied this symlink's content into secrets/ and did not set the link aside: finish that, do not call the link a stranger.
		plan.secrets.push({ name, action: "move", why: "finishing a run that crashed after the copy" });
		return;
	}
	if (state === "reappeared") {
		// Moved by an earlier migration and written again at the old name: never read, never moved over the one in secrets/.
		planReappearedSecret(plan, name, { from, to, there });
		return;
	}
	if (!isPrivateFile(st)) {
		plan.secrets.push({
			name,
			action: "skip",
			why: `mode ${modeText(st.mode)}, not 0600: chmod 600 it and run again`,
		});
		plan.problems.push(`${name}: not moved, because it is not mode exactly 0600`);
		return;
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

/** Non-secret files to rename: every file a key came from this run, and any a crash left migrated but not yet renamed. */
function planRenames({ conf, plan }: PlanCtx) {
	const fileNames = new Set(
		plan.added.flatMap((a) => {
			const f = a.from.split(" ")[0];
			return f !== undefined && Object.hasOwn(NON_SECRET_HOME, f) ? [f] : [];
		}),
	);
	for (const f of Object.keys(NON_SECRET_HOME)) if (oldFileState(conf, f, false) === "pending") fileNames.add(f);
	plan.renames = [...fileNames];
}

/** The `migrated.files` list of everything moved or about to be, and whether config.json has to be written for it. */
function planMigratedList({ conf, doc, plan }: PlanCtx) {
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
}

/** Old names written again after a move, and old files never migrated that are still read as a fallback. */
function planLeftovers({ conf, plan }: PlanCtx) {
	plan.reappeared = reappearedFiles(conf);
	plan.leftovers = [
		...Object.keys(NON_SECRET_HOME).filter(
			(f) => oldFileState(conf, f, false) === "usable" && !plan.renames.includes(f),
		),
		...plan.secrets
			.filter((s) => s.action === "skip" && oldFileState(conf, s.name, true) === "usable")
			.map((s) => s.name),
	];
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
	const ctx: PlanCtx = { conf, existing, doc, plan };
	noteUnreadSettings(conf, plan);
	foldLegacyKeys(ctx);
	foldThreadIds(ctx);
	foldDaemonEnv(ctx);
	for (const name of secretNames(conf, doc)) planSecret(ctx, name);
	planRenames(ctx);
	planMigratedList(ctx);
	planLeftovers(ctx);
	return plan;
}
