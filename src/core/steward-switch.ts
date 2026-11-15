/**
 * CLI: `chamberlain steward prepare|switch|status` and the `switch-steward` alias (requires --live).
 */
import { CONF } from "./config.ts";
import { crashPoint } from "./crash.ts";
import { defaultStore } from "./default-store.ts";
import { commitSwitch, mirrorSwitch } from "./steward-commit.ts";
import { abortSwitch, prepareRollback, prepareSwitch } from "./steward-prepare.ts";
import { stewardStatus } from "./steward-status.ts";

const usage = `usage:
  chamberlain steward prepare <thread> --live
  chamberlain steward prepare --rollback <gen> --live
  chamberlain steward switch <id> --live [--no-compact] [--abort]
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
	if (cmd === "status") return cmdStatus(rest);
	console.error(usage);
	return 2;
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
