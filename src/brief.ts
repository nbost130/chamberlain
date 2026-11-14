/**
 * Prints the Steward's hand-off: `bun src/brief.ts steward [--predecessor <threadId>] [--mode test|live]`. The text is built by
 * src/core/brief.ts; the sentences about the backend come from the adapter that serves the Steward's own server, and the operator's
 * brief fragments (`<config>/brief.d/*.md`) are appended last.
 *
 * `bun src/brief.ts desk` prints the Alert Desk's standing prompt (docs/alert-desk-prompt.md, or `alert-desk-prompt.md` in the config
 * directory when there is one), filled in from the config: `principalName`, the Steward's own server in servers.json, the command that
 * runs the desk allowlist hook, the ask command the desk allowlist accepts (`deskAskCommand`: DESK_ASK_PATH, else this build's own), and
 * the morning sources in alert-desk.json (src/core/alert-desk.ts `renderDeskPrompt`).
 */
import { readFileSync, existsSync } from "node:fs";
import { defaultStore } from "./core/default-store.ts";
import { readAfk } from "./core/afk.ts";
import { deskAskCommand, readOperator, renderDeskPrompt } from "./core/alert-desk.ts";
import { loadBriefFragments, stewardBrief } from "./core/brief.ts";
import { CONF, principal, REPO, selfCommand } from "./core/config.ts";
import { startup } from "./core/migrate.ts";
import { loadOperatingRules } from "./core/rules.ts";
import { rulingsBriefText } from "./core/rulings.ts";
import { homeServer } from "./core/servers.ts";
import { adapterEntry, loadServers } from "./adapters/index.ts";
import { DESK_PROMPT_FILE } from "./embedded.ts";

export function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const store = defaultStore();
	const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
	if (argv[0] !== "steward" && argv[0] !== "desk") { console.error("usage: brief.ts steward [--predecessor <threadId>] [--mode test|live] | brief.ts desk"); process.exit(2); }
	const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
	const servers = loadServers(CONF);
	if (argv[0] === "desk") {
		const own = `${CONF}/alert-desk-prompt.md`;
		const template = existsSync(own) ? text(own) : text(DESK_PROMPT_FILE);
		const operator = readOperator(CONF, (m) => console.error(m));
		console.log(renderDeskPrompt(template, { principalName: principal(), serverName: homeServer(servers).name, allowlistHook: `${selfCommand("desk-allowlist")} hook`, askCommand: deskAskCommand(), morning: operator.morning, shapes: operator.shapes, gatherer: operator.gatherer }));
		process.exit(0);
	}
	console.log(stewardBrief({
		mode: flag("--mode") === "live" ? "live" : "test",
		repo: REPO,
		rights: text(`${CONF}/decision-rights.md`),
		rulings: rulingsBriefText(store),
		operatingRules: loadOperatingRules(CONF),
		afk: readAfk(store),
		environments: servers,
		predecessor: flag("--predecessor"),
		notes: adapterEntry(homeServer(servers).adapter).brief?.({ repo: REPO }),
		fragments: loadBriefFragments(CONF),
	}));
}

if (import.meta.main) main();
