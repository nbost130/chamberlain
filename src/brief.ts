/**
 * Prints the Steward's hand-off: `bun src/brief.ts steward [--predecessor <threadId>] [--mode test|live]`. The text is built by
 * src/core/brief.ts; the sentences about the backend come from the adapter that serves the Steward's own server.
 */
import { readFileSync, existsSync } from "node:fs";
import { defaultStore } from "./core/default-store.ts";
import { readAfk } from "./core/afk.ts";
import { stewardBrief } from "./core/brief.ts";
import { CONF, REPO } from "./core/config.ts";
import { startup } from "./core/migrate.ts";
import { loadOperatingRules } from "./core/rules.ts";
import { rulingsText } from "./core/rulings.ts";
import { homeServer } from "./core/servers.ts";
import { adapterEntry, loadServers } from "./adapters/index.ts";

startup();
const store = defaultStore();
const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] !== "steward") { console.error("usage: brief.ts steward [--predecessor <threadId>] [--mode test|live]"); process.exit(2); }
const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const servers = loadServers(CONF);
console.log(stewardBrief({
	mode: flag("--mode") === "live" ? "live" : "test",
	repo: REPO,
	rights: text(`${CONF}/decision-rights.md`),
	rulings: rulingsText(store),
	operatingRules: loadOperatingRules(CONF),
	afk: readAfk(store),
	environments: servers,
	predecessor: flag("--predecessor"),
	notes: adapterEntry(homeServer(servers).adapter).brief?.({ repo: REPO }),
}));
