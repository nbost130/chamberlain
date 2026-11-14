/**
 * The one-time importer: copies the old file layout into the database. It reads only and changes nothing it reads.
 *
 *   bun src/cli/import.ts --from <dir> [--from <dir> ...] [--to <state dir>] [--dry-run] [--report <file>]
 *   bun src/cli/import.ts --from-env  [--to <state dir>] [--dry-run]
 *
 * `--from` names a directory holding the old files (queue.jsonl, rulings.jsonl, woken/ ...): the old cache directory, the config
 * directory, or one directory holding both, or with `conf/` and `cache/` inside it. Give it twice to name both.
 * `--from-env` reads the directories the old process was configured with: CHAMBERLAIN_CONF and CHAMBERLAIN_CACHE (the file layout's
 * cache directory, which no longer holds state), or the
 * earlier system's LEGACY_WAKE_CONF and LEGACY_WAKE_CACHE (the default directories where they are not set).
 * `--to` is the state directory that holds (or will hold) chamberlain.db; the default is CHAMBERLAIN_STATE (~/.local/state/chamberlain).
 *
 * It is idempotent: run it again and it imports nothing new. It writes its report to stdout and, with `--report`, to a file.
 * Stop the daemon and the page first, so no old process is writing the files while they are read.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATE } from "../core/config.ts";
import { formatReport, importLegacy } from "../core/legacy-import.ts";
import { SchemaTooNewError } from "../core/schema.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath } from "../core/store.ts";

export function main(argv: string[] = process.argv.slice(2)) {
	const all = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
	const one = (flag: string) => all(flag)[0];
	const HOME = process.env.HOME!;

	function fail(msg: string, code = 2): never { console.error(msg); process.exit(code); }

	let from = all("--from");
	if (argv.includes("--from-env")) {
		const env = process.env;
		// An empty variable counts as unset.
		from = [env.CHAMBERLAIN_CONF || env.LEGACY_WAKE_CONF || `${HOME}/.config/chamberlain`, env.CHAMBERLAIN_CACHE || env.LEGACY_WAKE_CACHE || `${HOME}/.cache/chamberlain`];
	}
	if (!from.length) fail("usage: bun src/cli/import.ts --from <dir> [--from <dir>] [--to <state dir>] [--dry-run] [--report <file>]\n       bun src/cli/import.ts --from-env");
	for (const d of from) if (!existsSync(d)) fail(`import: no such directory: ${d}`);
	const to = one("--to") ?? STATE;
	const dry = argv.includes("--dry-run");

	/** A dry run opens the real database only if it exists; it never creates one. */
	const dryRunPath = (state: string): string => (dry && !existsSync(dbPath(state)) ? ":memory:" : dbPath(state));

	try {
		const store = openStore(dryRunPath(to));
		try {
			const report = importLegacy(store, from, { dryRun: dry });
			const text = formatReport(report);
			console.log(text);
			const file = one("--report");
			if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); console.log(`\nreport written to ${file}`); }
		} finally { store.close(); }
	} catch (e) {
		if (e instanceof SchemaTooNewError) fail(`chamberlain: ${e.message}\nNothing was imported.`, 3);
		throw e;
	}
}

if (import.meta.main) main();
