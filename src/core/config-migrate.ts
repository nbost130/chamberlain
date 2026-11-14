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
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { dirname } from "node:path";
import { isObject } from "./config-fold.ts";
import { movedBeforeCrash, type Plan, planMigration } from "./config-plan.ts";
import { FlockBusyError, holdFlock, RelayLockUnavailableError } from "./flock.ts";
import { ensureSecretsDir, syncDir, writeConfigFile, writeFileDurable } from "./layout.ts";
import { attachDeprecationLog, JOURNAL, MIGRATED_SUFFIX, reappeared } from "./layout-legacy.ts";
import { readConfigFile } from "./layout-read.ts";
import { CONFIG_FILE, parseConfigDoc, SECRETS_DIR, type ThreadKey } from "./layout-schema.ts";

/** Leftover temporary files of a run that crashed: `secrets/*.tmp-<pid>` and the flushed-write temporaries beside config.json. Safe to remove under the lock. */
function removeStaleTemporaries(conf: string): void {
	for (const dir of [`${conf}/${SECRETS_DIR}`, conf]) {
		try {
			for (const e of readdirSync(dir))
				if (/\.tmp-\d+$/.test(e) && (dir !== conf || e.startsWith(CONFIG_FILE) || e.startsWith(JOURNAL)))
					rmSync(`${dir}/${e}`, { force: true });
		} catch {
			// EMPTY_CATCH_OK: no such directory, nothing to clean.
		}
	}
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

/** Moves each secret into secrets/. A symlink is written under the secret's name by content and set aside, a file is renamed. */
function moveSecrets(conf: string, moves: Plan["secrets"], after: AfterStep) {
	for (const s of moves) {
		const from = `${conf}/${s.name}`;
		const to = `${conf}/${SECRETS_DIR}/${s.name}`;
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		if (lstatSync(from).isSymbolicLink()) {
			// A symlink cannot be moved as a secret (it would point at nothing from secrets/): its content is written under the secret's name,
			// keeping the target's date, and the link itself is set aside as <name>.migrated.
			if (!existsSync(to)) {
				const target = statSync(from);
				const tmp = `${to}.tmp-${process.pid}`;
				rmSync(tmp, { force: true });
				copyFileSync(from, tmp);
				chmodSync(tmp, 0o600);
				utimesSync(tmp, target.atime, target.mtime);
				renameSync(tmp, to);
				after(`secret-copied:${s.name}`); // a test seam: the copy is done, the link is not yet set aside
			}
			renameSync(from, `${conf}/${freeMigratedName(conf, s.name)}`);
		} else {
			renameSync(from, to); // atomic; the mtime goes with it (the token-age alarm reads it), and one copy is left
		}
		after(`secret:${s.name}`);
	}
}

/** Only now, with config.json safely on disk, are the non-secret files set aside. True when any was. */
function renameNonSecrets(conf: string, renames: string[], after: AfterStep): boolean {
	let changed = false;
	for (const f of renames) {
		if (!existsSync(`${conf}/${f}`)) continue;
		renameSync(`${conf}/${f}`, `${conf}/${freeMigratedName(conf, f)}`);
		changed = true;
		after(`rename:${f}`);
	}
	return changed;
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
	}
	removeStaleTemporaries(conf);
	if (moves.length || plan.renames.length) {
		// The journal is the UNION of what earlier crashed runs moved and what this one will: a run that overwrote it would forget the first.
		const secrets = [...new Set([...movedBeforeCrash(conf), ...moves.map((m) => m.name)])];
		writeFileDurable(`${conf}/${JOURNAL}`, `${JSON.stringify({ secrets, renames: plan.renames })}\n`);
	}
	moveSecrets(conf, moves, after);
	if (moves.length) {
		changed = true;
		syncDir(`${conf}/${SECRETS_DIR}`);
		syncDir(conf);
	}
	if (plan.writeConfig) {
		parseConfigDoc(plan.config);
		writeConfigFile(conf, plan.config); // flushed, then the directory: config.json is on disk before any file is set aside
		changed = true;
		after("config");
	}
	if (renameNonSecrets(conf, plan.renames, after)) changed = true;
	if (plan.renames.length) syncDir(conf);
	rmSync(`${conf}/${JOURNAL}`, { force: true }); // every step is done: nothing is pending any more
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
function updateConfig(conf: string, mutate: (doc: Record<string, unknown>) => void): void {
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
		if (todo || probe.renames.length || existsSync(`${conf}/${JOURNAL}`)) {
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
