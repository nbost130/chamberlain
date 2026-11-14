/**
 * `chamberlain config`: look at the config directory and move it to the new layout.
 *
 *   chamberlain config migrate [--dry-run]   MOVE the old files into config.json and secrets/ (secrets renamed into secrets/, the rest set aside as <name>.migrated)
 *   chamberlain config revert [--dry-run]    put the old layout back, so an older build starts again; config.json becomes config.json.reverted
 *   chamberlain config show                  every key with where its value comes from, every secret with where it is read from, and any old file that reappeared
 *   chamberlain config get <key>             print one value for a script (threads.steward, web.port, stallMs); never a secret
 *
 * None of them prints a secret, and `migrate` prints key names and file names, never values. See docs/config-migration.md.
 */
import { readdirSync } from "node:fs";
import { CONF } from "./config.ts";
import { migrateLayout, type Plan, revertLayout } from "./config-migrate.ts";
import {
	CONFIG_FILE,
	cfg,
	configValue,
	envName,
	homeOfOld,
	isPrivateSecret,
	oldFileState,
	readConfigFile,
	reappearedFiles,
	SCALARS,
	type ScalarKey,
	SECRET_FILE,
	SECRETS_DIR,
	setting,
	settingSource,
	THREADS,
	type ThreadKey,
	thread,
} from "./layout.ts";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The line `config show` and `config migrate` print for an old file that a migration moved and something wrote again. */
export const reappearedLine = (name: string): string =>
	SECRET_FILE.test(name)
		? `REAPPEARED  ${name}: written at its old place after the migration, and NEVER read. The secret lives in ${homeOfOld(name)}. Mint new secrets into ${SECRETS_DIR}/<name>, not at the old path.`
		: `REAPPEARED  ${name}: written at its old place after the migration, and NEVER read. The value lives in ${homeOfOld(name)}. Change settings in config.json.`;

/** The line for one secret of a plan. */
function secretLine(s: Plan["secrets"][number], would: boolean): string {
	if (s.action === "move")
		return `${SECRETS_DIR}/${s.name}: ${would ? "would move" : "moved"} here (mode 0600, date kept)`;
	if (s.action === "present") return `${SECRETS_DIR}/${s.name}: already there${s.why ? `; ${s.why}` : ""}`;
	return `${SECRETS_DIR}/${s.name}: ${s.action === "skip" ? "skipped" : "differs"}: ${s.why}`;
}

/** The lines for the config.json part of a plan: the write and each key added. */
function addedLines(plan: Plan, would: boolean): string[] {
	const out: string[] = [];
	if (plan.writeConfig)
		out.push(
			`${CONFIG_FILE}: ${would ? "would write" : "wrote"} ${plan.added.length} key${plan.added.length === 1 ? "" : "s"}`,
		);
	for (const a of plan.added) out.push(`  + ${a.key}   (from ${a.from})`);
	return out;
}

/** The lines a plan ends with: the files that stay, the ones that came back, and the ones left unmigrated. */
function leftoverLines(plan: Plan): string[] {
	const out: string[] = [];
	if (plan.stays.length) out.push(`stay as files: ${plan.stays.join(", ")}`);
	for (const f of plan.reappeared) out.push(reappearedLine(f));
	if (plan.leftovers.length)
		out.push(
			`not migrated, and still read from their old place: ${plan.leftovers.join(", ")}. Fix what is reported above and run \`chamberlain config migrate\` again.`,
		);
	return out;
}

/** Pure: the lines `config migrate` prints for a plan. Names and sources only. */
export function planLines(plan: Plan, o: { dryRun: boolean; skipped?: string }): string[] {
	const out: string[] = [];
	const would = o.dryRun;
	if (o.skipped) out.push(`not migrated: ${o.skipped}`);
	const moves = plan.secrets.filter((s) => s.action === "move");
	if (!plan.writeConfig && !moves.length && !plan.renames.length)
		out.push("nothing to do: config.json and secrets/ already hold everything the old files do");
	out.push(...addedLines(plan, would));
	for (const s of plan.secrets) out.push(secretLine(s, would));
	for (const f of plan.renames) out.push(`${f}: ${would ? "would be set" : "set"} aside as ${f}.migrated`);
	for (const d of plan.differs)
		out.push(`differs: ${d.key} in ${d.from} is not what config.json holds; config.json wins`);
	for (const n of plan.notes) out.push(`note: ${n}`);
	for (const p of plan.problems) out.push(`PROBLEM: ${p}`);
	out.push(...leftoverLines(plan));
	if (!would && (moves.length || plan.renames.length))
		out.push("the old files were MOVED, not copied. `chamberlain config revert` puts them back.");
	return out;
}

/** A value for a script: a string bare, anything else as JSON. */
const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The value at a path below a section's value: an object key, or a list index. Anything that is not there is undefined. */
function walkPath(start: unknown, path: string[]): unknown {
	let cur = start;
	for (const p of path) {
		if (Array.isArray(cur)) cur = /^\d+$/.test(p) ? cur[Number(p)] : undefined;
		else if (isObject(cur) && Object.hasOwn(cur, p)) cur = cur[p];
		else cur = undefined;
	}
	return cur;
}

/** The value a key names, or why it names none. */
function lookup(
	key: string,
	parts: string[],
	conf: string,
	env: Record<string, string | undefined>,
): { value: unknown } | { error: string } {
	const [head = "", second, ...more] = parts;
	if (head === "threads" && second !== undefined && more.length === 0) {
		if (!(THREADS as readonly string[]).includes(second))
			return { error: `no such thread: ${second} (${THREADS.join(", ")})` };
		return { value: thread(conf, second as ThreadKey) };
	}
	if (Object.hasOwn(SCALARS, key)) return { value: setting(key as ScalarKey, conf, env) };
	return { value: walkPath(cfg(conf, head), parts.slice(1)) };
}

/**
 * `chamberlain config get <key>`: one value, for a script. A key is a scalar (`stallMs`), `threads.<steward|decisions|desk>`, or a path into a
 * section (`web.port`, `servers.0.name`). A secret is refused: a secret is a file in secrets/, read by the program that needs it.
 */
export function getValue(
	key: string,
	conf = CONF,
	env: Record<string, string | undefined> = process.env,
): { ok: true; text: string } | { ok: false; error: string } {
	const parts = key.split(".");
	if (!key || parts.some((p) => p === ""))
		return { ok: false, error: "usage: chamberlain config get <key>, for example threads.steward" };
	if (parts[0] === SECRETS_DIR || SECRET_FILE.test(key))
		return {
			ok: false,
			error: `${key}: that names a secret. config get never prints one; secrets are files in ${SECRETS_DIR}/`,
		};
	const found = lookup(key, parts, conf, env);
	if ("error" in found) return { ok: false, error: found.error };
	if (found.value === undefined) return { ok: false, error: `${key}: not set` };
	return { ok: true, text: asText(found.value) };
}

/** The `settings` block of `config show`: each scalar that is not at its default, with where its value comes from. */
function settingLines(conf: string, env: Record<string, string | undefined>): string[] {
	const out: string[] = [];
	for (const k of Object.keys(SCALARS) as ScalarKey[]) {
		const src = settingSource(k, conf, env);
		if (src === "default") continue;
		const e = env[envName(k)];
		const v = src.startsWith("env ") ? e : (configValue(conf, k)?.value as unknown);
		out.push(`  ${k.padEnd(22)} ${JSON.stringify(v)}   (${src})`);
	}
	return out;
}

/** What `config show` says about the value of one section: how many entries, which keys, or only that it is set. */
function describeSection(k: string, value: unknown): string {
	if (Array.isArray(value))
		return `${value.length} entr${value.length === 1 ? "y" : "ies"}${k === "servers" ? ` (${value.map((s) => (isObject(s) ? s.name : "?")).join(", ")})` : ""}`;
	return isObject(value) ? `keys: ${Object.keys(value).join(", ")}` : "set";
}

/** The `sections` block of `config show`. */
function sectionLines(conf: string): string[] {
	const out: string[] = [];
	for (const k of ["settledMatch", "servers", "web", "sweep", "alertDesk", "operatingRules", "judge"] as const) {
		const v = configValue(conf, k);
		if (!v) continue;
		out.push(
			`  ${k.padEnd(22)} ${describeSection(k, v.value)}   (${v.file === CONFIG_FILE ? CONFIG_FILE : `legacy ${v.file}`})`,
		);
	}
	return out;
}

/** The `threads` block of `config show`. */
function threadLines(doc: Record<string, unknown> | undefined): string[] {
	const t = doc && isObject(doc.threads) ? doc.threads : {};
	return THREADS.map((m) => {
		const inDoc = Object.hasOwn(t, m);
		return `  ${m.padEnd(22)} ${inDoc ? (t[m] ? JSON.stringify(t[m]) : "none") : "(not in config.json; a file never migrated is read if there is one)"}`;
	});
}

/** One directory's secrets for `config show`, each named once and flagged when its mode is wrong. A directory that is not there lists none. */
function listSecrets(out: string[], named: Set<string>, dir: string, label: string, only: (n: string) => boolean) {
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (!e.isFile() || /\.tmp-\d+$/.test(e.name) || !only(e.name) || named.has(e.name)) continue;
			named.add(e.name);
			const ok = isPrivateSecret(`${dir}/${e.name}`);
			out.push(`  ${e.name.padEnd(28)} ${label}${ok ? "" : "   MODE NOT 0600: refused"}`);
		}
	} catch {
		// EMPTY_CATCH_OK: no such directory means no secrets there.
	}
}

/** The `secrets` block of `config show`: secrets/ first, then the old place. */
function secretLines(conf: string): string[] {
	const out: string[] = [];
	const named = new Set<string>();
	listSecrets(out, named, `${conf}/${SECRETS_DIR}`, `${SECRETS_DIR}/`, () => true);
	listSecrets(
		out,
		named,
		conf,
		"config directory (old place, deprecated)",
		(n) => SECRET_FILE.test(n) && oldFileState(conf, n, true) === "usable",
	);
	if (!named.size) out.push("  (none)");
	return out;
}

/** The effective config and where each part comes from, one line each. Secrets are named, never read out. */
export function showLines(conf = CONF, env = process.env): string[] {
	const out: string[] = [];
	const doc = readConfigFile(conf);
	out.push(`config directory  ${conf}`);
	out.push(`${CONFIG_FILE}  ${doc ? "present" : "absent (the old files, if any, are read as a fallback)"}`);
	const gone = reappearedFiles(conf);
	for (const f of gone) out.push("", reappearedLine(f));
	out.push("", "settings (environment, then config.json, then an old file, then the default):");
	out.push(...settingLines(conf, env));
	out.push("", "sections:");
	out.push(...sectionLines(conf));
	out.push("", "threads:");
	out.push(...threadLines(doc));
	out.push("", `secrets (${SECRETS_DIR}/ first, then the old place):`);
	out.push(...secretLines(conf));
	return out;
}

/** Whether `--dry-run` is among the arguments of `migrate` or `revert`. Any other argument is refused with the usage. */
function dryRunFlag(sub: "migrate" | "revert", rest: string[]): boolean {
	const extra = rest.filter((a) => a !== "--dry-run");
	if (extra.length) throw Error(`usage: chamberlain config ${sub} [--dry-run] (unknown: ${extra.join(" ")})`);
	return rest.includes("--dry-run");
}

function migrateCommand(rest: string[]): void {
	const dryRun = dryRunFlag("migrate", rest);
	const r = migrateLayout(CONF, { dryRun });
	for (const l of planLines(r.plan, { dryRun, skipped: r.skipped })) console.log(l);
	if (r.skipped || r.plan.problems.length) process.exitCode = 1;
}

function revertCommand(rest: string[]): void {
	const dryRun = dryRunFlag("revert", rest);
	const r = revertLayout(CONF, { dryRun });
	if (r.skipped) console.log(`not reverted: ${r.skipped}`);
	for (const l of r.done) console.log(l);
	for (const n of r.notes) console.log(`note: ${n}`);
	for (const p of r.problems) console.log(`PROBLEM: ${p}`);
	if (r.skipped || r.problems.length) process.exitCode = 1;
}

function getCommand(rest: string[]): void {
	const [key] = rest;
	if (rest.length !== 1 || key === undefined) {
		console.error("usage: chamberlain config get <key>   (for example threads.steward, web.port, stallMs)");
		process.exitCode = 2;
		return;
	}
	const r = getValue(key);
	if (r.ok) console.log(r.text);
	else {
		console.error(r.error);
		process.exitCode = 1;
	}
}

export function main(argv: string[] = process.argv.slice(2)): void {
	const [sub, ...rest] = argv;
	if (sub === "migrate") migrateCommand(rest);
	else if (sub === "revert") revertCommand(rest);
	else if (sub === "show") for (const l of showLines()) console.log(l);
	else if (sub === "get") getCommand(rest);
	else {
		console.error("usage: chamberlain config migrate [--dry-run] | revert [--dry-run] | show | get <key>");
		process.exitCode = 2;
	}
}

if (import.meta.main) main();
