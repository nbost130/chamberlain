/**
 * CLI: `chamberlain steward prepare|switch|status` and the `switch-steward` alias (requires --live).
 */
import { readFileSync } from "node:fs";
import { CONF } from "../config/config.ts";
import { crashPoint } from "../crash.ts";
import { defaultStore } from "../store/default-store.ts";
import { commitSwitch, mirrorSwitch } from "./steward-commit.ts";
import { publishSwitchRef } from "./steward-gens.ts";
import { abortSwitch, prepareRollback, prepareSwitch } from "./steward-prepare.ts";
import { stewardStatus } from "./steward-status.ts";

const usage = `usage:
  chamberlain steward prepare <thread> --live
  chamberlain steward prepare --rollback <gen> --live
  chamberlain steward switch <id> --live [--no-compact] [--abort]
  chamberlain steward publish-ref <id> wake|compact --file <path> --live
  chamberlain steward status [--id <delivery id>]
  chamberlain switch-steward <thread> --live   (alias of prepare+legacy; requires --live)`;

function hasFlag(argv: string[], flag: string): boolean {
	return argv.includes(flag);
}

function takeArg(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** `steward` subcommand dispatcher. */
export function runStewardCli(argv: string[]): number {
	const [cmd, ...rest] = argv;
	if (cmd === "prepare") return cmdPrepare(rest);
	if (cmd === "switch") return cmdSwitch(rest);
	if (cmd === "publish-ref") return cmdPublishRef(rest);
	if (cmd === "status") return cmdStatus(rest);
	console.error(usage);
	return 2;
}

/** Successor publication path: durable write of a switch-owned wake/compact URL via publishSwitchRef. */
function cmdPublishRef(argv: string[]): number {
	if (!hasFlag(argv, "--live")) {
		console.error("steward publish-ref requires --live");
		return 2;
	}
	const id = argv.find((a) => !a.startsWith("-"));
	const kind = argv.find((a) => a === "wake" || a === "compact") as "wake" | "compact" | undefined;
	const file = takeArg(argv, "--file");
	if (!id || !kind || !file) {
		console.error(usage);
		return 2;
	}
	let body: string;
	try {
		body = readFileSync(file, "utf8");
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 2;
	}
	if (!body.endsWith("\n")) body += "\n";
	if (!publishSwitchRef(CONF, id, kind, body)) {
		console.error(`ref already exists or could not be published: ${id}.${kind}`);
		return 3;
	}
	console.log(`published ${id}.${kind}`);
	return 0;
}

function cmdPrepare(argv: string[]): number {
	const live = hasFlag(argv, "--live");
	const rollbackGen = takeArg(argv, "--rollback");
	const store = defaultStore();
	try {
		if (rollbackGen) {
			const r = prepareRollback(store, CONF, { toGen: Number(rollbackGen), live });
			if (!r.ok) {
				console.error(r.error);
				return r.code;
			}
			crashPoint("switch-prepared");
			console.log(`prepared ${r.id} (rollback)\nwake: ${r.wakePath}\ncompact: ${r.compactPath}`);
			return 0;
		}
		const thread = argv.find((a) => !a.startsWith("-"));
		if (!thread) {
			console.error(usage);
			return 2;
		}
		const r = prepareSwitch(store, CONF, { toThread: thread, live });
		if (!r.ok) {
			console.error(r.error);
			return r.code;
		}
		crashPoint("switch-prepared");
		console.log(`prepared ${r.id}\nwake: ${r.wakePath}\ncompact: ${r.compactPath}`);
		return 0;
	} finally {
		store.close();
	}
}

function cmdSwitch(argv: string[]): number {
	const live = hasFlag(argv, "--live");
	const id = argv.find((a) => !a.startsWith("-"));
	if (!id) {
		console.error(usage);
		return 2;
	}
	const store = defaultStore();
	try {
		if (hasFlag(argv, "--abort")) {
			const r = abortSwitch(store, id);
			if (!r.ok) {
				console.error(r.error);
				return r.code;
			}
			console.log(`aborted ${id}`);
			return 0;
		}
		const r = commitSwitch(store, CONF, { id, live, noCompact: hasFlag(argv, "--no-compact") });
		if (!r.ok) {
			console.error(r.error);
			return r.code;
		}
		const m = mirrorSwitch(store, CONF, id);
		if (!m.ok) {
			console.error(m.error);
			return m.code;
		}
		console.log(`steward switched (generation ${r.toGen})`);
		return 0;
	} finally {
		store.close();
	}
}

function cmdStatus(argv: string[]): number {
	const id = takeArg(argv, "--id") ?? argv.find((a) => !a.startsWith("-"));
	const store = defaultStore();
	try {
		for (const line of stewardStatus(store, id)) console.log(line);
		return 0;
	} finally {
		store.close();
	}
}

export function main(argv: string[] = process.argv.slice(2)): number {
	return runStewardCli(argv);
}

if (import.meta.main) process.exitCode = main();
