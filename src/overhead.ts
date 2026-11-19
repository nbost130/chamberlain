/**
 * Prints Chamberlain's overhead against the work done: `bun src/overhead.ts`. Measures now (rolling 24 h and 7 days), changes nothing, and
 * opens no investigation; the daemon does that, once a day, when a threshold is crossed (docs/OBSERVABILITY.md, "Overhead").
 *
 *   overhead [--json]                         the numbers, the thresholds, what crossed and what could not be read
 *   overhead close <id> [--note "<text>"]     ends an investigation (the investigator runs this when it is done)
 *   overhead investigations                   the recorded investigations, newest last
 */
import { CONF } from "./core/config/config.ts";
import { startup } from "./core/config/migrate.ts";
import { ghRead } from "./core/gh.ts";
import { collect } from "./core/overhead/collect.ts";
import { formatOverhead } from "./core/overhead/format.ts";
import { overheadSettings } from "./core/overhead/settings.ts";
import { closeInvestigation, type Investigation, readOverheadState, settle } from "./core/overhead/trigger.ts";
import { defaultStore } from "./core/store/default-store.ts";

const when = (ms: number | undefined) => (ms === undefined ? "-" : new Date(ms).toISOString().slice(0, 16));

export function formatInvestigations(list: readonly Investigation[]): string {
	if (!list.length) return "no investigations";
	return list
		.map(
			(i) =>
				`${i.id}\t${i.status === "open" ? "open" : `closed ${when(i.closedAt)} (${i.closedBy})`}\topened ${when(i.openedAt)}\tthread ${i.threadId ?? "-"}${i.note ? `\t${i.note}` : ""}`,
		)
		.join("\n");
}

/** The text after `--note`, if given. */
const noteOf = (argv: string[]): string | undefined => {
	const at = argv.indexOf("--note");
	return at > 0 ? argv[at + 1] : undefined;
};

const withStore = async <T>(f: (store: ReturnType<typeof defaultStore>) => T | Promise<T>): Promise<T> => {
	const store = defaultStore();
	try {
		return await f(store);
	} finally {
		store.close();
	}
};

const measure = (json: boolean) =>
	withStore(async (store) => {
		const { cfg: cfgDoc, model } = overheadSettings(CONF);
		const report = await collect({ store, cfg: cfgDoc, ...(model ? { model } : {}), gh: ghRead, now: Date.now() });
		if (json) return console.log(JSON.stringify(report, null, 2));
		console.log(formatOverhead(report));
		const open = settle(readOverheadState(store), Date.now(), cfgDoc).investigations.filter((i) => i.status === "open");
		console.log(open.length ? `  INVESTIGATION OPEN: ${open.map((i) => i.id).join(", ")}` : "  No investigation open.");
	});

const close = (argv: string[]) => {
	const id = argv[1];
	if (!id) throw Error('usage: overhead close <id> [--note "<text>"]');
	startup();
	return withStore((store) => {
		const note = noteOf(argv);
		const r = closeInvestigation(store, id, { by: "investigator", now: Date.now(), ...(note ? { note } : {}) });
		console.log(r.already ? `${id} was already closed` : `${id} closed`);
	});
};

export async function main(argv: string[] = process.argv.slice(2)) {
	try {
		if (argv[0] === "close") await close(argv);
		else if (argv[0] === "investigations")
			await withStore((store) => console.log(formatInvestigations(readOverheadState(store).investigations)));
		else if (argv.length === 0 || (argv.length === 1 && argv[0] === "--json")) await measure(argv[0] === "--json");
		else throw Error('usage: overhead [--json] | close <id> [--note "<text>"] | investigations');
	} catch (e) {
		console.error(`overhead: ${String(e instanceof Error ? e.message : e)}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
