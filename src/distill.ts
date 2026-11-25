import { parseArgs } from "node:util";
import { homeAdapter } from "./adapters/index.ts";
import { CONF, STATE } from "./core/config/config.ts";
import { cfg, thread } from "./core/config/layout.ts";
import { saveDistillWeek } from "./core/distill/history.ts";
import { readDistillLedger } from "./core/distill/ledger.ts";
import { type ChatRead, distillReport, formatDistill } from "./core/distill/report.ts";
import { distillSettings, distillWindow } from "./core/distill/window.ts";
import { ghRead } from "./core/gh.ts";
import { overheadSettings } from "./core/overhead/settings.ts";
import { dbPath } from "./core/store/store.ts";

const usage = "usage: distill [--days N] [--json]";

function options(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: { days: { type: "string", default: "7" }, json: { type: "boolean" } },
	});
	const days = Number(values.days);
	if (!/^\d+$/.test(values.days) || days < 1 || days > 366) throw Error(usage);
	return { days, json: values.json };
}

function chatReader(): ChatRead | undefined {
	try {
		const inspect = homeAdapter().adapter.inspect;
		const count = inspect?.countPrincipalMessages?.bind(inspect);
		return count ? ({ thread, from, to }) => count(thread, { from, to }) : undefined;
	} catch {
		return undefined;
	}
}

export async function main(argv: string[] = process.argv.slice(2)) {
	let args: ReturnType<typeof options>;
	try {
		args = options(argv);
	} catch {
		console.error(usage);
		process.exitCode = 1;
		return;
	}
	try {
		const config = distillSettings(cfg(CONF, "distill"));
		const window = distillWindow(Date.now(), args.days, config.timezone);
		const ledger = readDistillLedger(
			dbPath(STATE),
			window.span,
			config.chat,
			config.chat ? thread(CONF, "steward") : undefined,
		);
		const report = await distillReport({
			...window,
			config,
			ledger,
			github: overheadSettings(CONF).cfg.github,
			gh: ghRead,
			readChat: config.chat ? chatReader() : undefined,
		});
		saveDistillWeek(STATE, report);
		console.log(args.json ? JSON.stringify(report, null, 2) : formatDistill(report));
	} catch {
		// A malformed ledger, config or adapter must not echo source payloads or secrets.
		console.error("distill: could not read configuration or ledger, or save weekly history");
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
