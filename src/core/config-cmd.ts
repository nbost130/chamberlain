/**
 * `chamberlain config`: look at the config directory and move it to the new layout.
 *
 *   chamberlain config migrate [--dry-run]   convert the old files into config.json and secrets/; leave the old files where they are
 *   chamberlain config show                  every key with where its value comes from, and every secret with where it is read from
 *
 * Neither prints a secret, and `migrate` prints key names and file names, never values. See docs/config-migration.md.
 */
import { readdirSync } from "node:fs";
import { CONF } from "./config.ts";
import { migrateLayout, type Plan } from "./config-migrate.ts";
import {
	CONFIG_FILE,
	SCALARS,
	SECRETS_DIR,
	THREADS,
	configValue,
	envName,
	isPrivateSecret,
	readConfigFile,
	settingSource,
	type ScalarKey,
} from "./layout.ts";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pure: the lines `config migrate` prints for a plan. Names and sources only. */
export function planLines(plan: Plan, o: { dryRun: boolean; skipped?: string }): string[] {
	const out: string[] = [];
	const would = o.dryRun;
	if (o.skipped) out.push(`not migrated: ${o.skipped}`);
	const copies = plan.secrets.filter((s) => s.action === "copy");
	if (!plan.writeConfig && !copies.length)
		out.push("nothing to do: config.json and secrets/ already hold everything the old files do");
	if (plan.writeConfig)
		out.push(
			`${CONFIG_FILE}: ${would ? "would write" : "wrote"} ${plan.added.length} key${plan.added.length === 1 ? "" : "s"}`,
		);
	for (const a of plan.added) out.push(`  + ${a.key}   (from ${a.from})`);
	for (const s of plan.secrets) {
		if (s.action === "copy") out.push(`${SECRETS_DIR}/${s.name}: ${would ? "would copy" : "copied"} (mode 0600)`);
		else if (s.action === "present") out.push(`${SECRETS_DIR}/${s.name}: already there`);
		else out.push(`${SECRETS_DIR}/${s.name}: ${s.action === "skip" ? "skipped" : "differs"}: ${s.why}`);
	}
	for (const d of plan.differs)
		out.push(`differs: ${d.key} in ${d.from} is not what config.json holds; config.json wins`);
	for (const n of plan.notes) out.push(`note: ${n}`);
	for (const p of plan.problems) out.push(`PROBLEM: ${p}`);
	if (plan.stays.length) out.push(`stay as files: ${plan.stays.join(", ")}`);
	if (plan.leftovers.length)
		out.push(
			`old files left in place: ${plan.leftovers.join(", ")}. Nothing was removed. config.json and secrets/ win; delete the old ones once \`chamberlain config show\` reads right.`,
		);
	return out;
}

/** The effective config and where each part comes from, one line each. Secrets are named, never read out. */
export function showLines(conf = CONF, env = process.env): string[] {
	const out: string[] = [];
	const doc = readConfigFile(conf);
	out.push(`config directory  ${conf}`);
	out.push(`${CONFIG_FILE}  ${doc ? "present" : "absent (the old files, if any, are read as a fallback)"}`);
	out.push("", "settings (environment, then config.json, then an old file, then the default):");
	for (const k of Object.keys(SCALARS) as ScalarKey[]) {
		const src = settingSource(k, conf, env);
		if (src === "default") continue;
		const e = env[envName(k)];
		const v = src.startsWith("env ") ? e : (configValue(conf, k)?.value as unknown);
		out.push(`  ${k.padEnd(22)} ${JSON.stringify(v)}   (${src})`);
	}
	out.push("", "sections:");
	for (const k of ["settledMatch", "servers", "web", "sweep", "alertDesk", "operatingRules", "judge"] as const) {
		const v = configValue(conf, k);
		if (!v) continue;
		const what = Array.isArray(v.value)
			? `${v.value.length} entr${v.value.length === 1 ? "y" : "ies"}${k === "servers" ? ` (${v.value.map((s) => (isObject(s) ? s.name : "?")).join(", ")})` : ""}`
			: isObject(v.value)
				? `keys: ${Object.keys(v.value).join(", ")}`
				: "set";
		out.push(`  ${k.padEnd(22)} ${what}   (${v.file === CONFIG_FILE ? CONFIG_FILE : `legacy ${v.file}`})`);
	}
	out.push("", "threads:");
	const t = isObject(doc?.threads) ? doc!.threads : {};
	for (const m of THREADS) {
		const inDoc = Object.hasOwn(t, m);
		out.push(
			`  ${m.padEnd(22)} ${inDoc ? (t[m] ? JSON.stringify(t[m]) : "none") : "(not in config.json; the old file is read if there is one)"}`,
		);
	}
	out.push("", `secrets (${SECRETS_DIR}/ first, then the old place):`);
	const seen = new Set<string>();
	const list = (dir: string, label: string, only: (n: string) => boolean) => {
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (!e.isFile() || !only(e.name) || seen.has(e.name)) continue;
				seen.add(e.name);
				const ok = isPrivateSecret(`${dir}/${e.name}`);
				out.push(`  ${e.name.padEnd(28)} ${label}${ok ? "" : "   MODE NOT 0600: refused"}`);
			}
		} catch {
			// EMPTY_CATCH_OK: no such directory means no secrets there.
		}
	};
	list(`${conf}/${SECRETS_DIR}`, `${SECRETS_DIR}/`, () => true);
	list(
		conf,
		"config directory (old place, deprecated)",
		(n) => /(^|-)(token|url)(\.[a-z]+)?$/.test(n) || n === "read-token",
	);
	if (!seen.size) out.push("  (none)");
	return out;
}

export function main(argv: string[] = process.argv.slice(2)): void {
	const [sub, ...rest] = argv;
	if (sub === "migrate") {
		const dryRun = rest.includes("--dry-run");
		const extra = rest.filter((a) => a !== "--dry-run");
		if (extra.length) throw Error(`usage: chamberlain config migrate [--dry-run] (unknown: ${extra.join(" ")})`);
		const r = migrateLayout(CONF, { dryRun });
		for (const l of planLines(r.plan, { dryRun, skipped: r.skipped })) console.log(l);
		if (r.skipped || r.plan.problems.length) process.exitCode = 1;
		return;
	}
	if (sub === "show") {
		for (const l of showLines()) console.log(l);
		return;
	}
	console.error("usage: chamberlain config migrate [--dry-run] | chamberlain config show");
	process.exitCode = 2;
}

if (import.meta.main) main();
