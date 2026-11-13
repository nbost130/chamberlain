/**
 * The decision-queue page: bun src/web/server.ts [--test]
 *
 * Binds only to the address in ~/.config/chamberlain/web.json (loopback or a Tailscale IP) and refuses a wildcard or a
 * missing one. An answer's wake is an outbox row written in the answer's own transaction; the daemon's relay sends it (src/core/relay.ts).
 *
 * --test runs against fixture data: CHAMBERLAIN_CONF and CHAMBERLAIN_STATE must point away from the live directories, the
 * address must be loopback, no wake is sent and no card is touched.
 */
import { CONF, STATE } from "../core/config.ts";
import { has } from "../core/adapter.ts";
import { configDir, stateDir } from "../core/state-dir.ts";
import { defaultStore } from "../core/default-store.ts";
import { makeLog } from "../core/log.ts";
import { maintain } from "../core/maintain.ts";
import { startup } from "../core/migrate.ts";
import { privateFile as readPrivateFile } from "../core/private.ts";
import type { ServerEntry } from "../core/servers.ts";
import { loadServers, makeAdapter } from "../adapters/index.ts";
import type { Adapter } from "../core/adapter.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { titleKeeper } from "./title.ts";
import { createWaiting, threadSender, withAnswerRights, type ServerAdapter } from "./waiting.ts";

const HOME = process.env.HOME!;
const TEST = process.argv.includes("--test");
if (TEST) {
	if (!process.env.CHAMBERLAIN_CONF || !process.env.CHAMBERLAIN_STATE || CONF === configDir({}, HOME) || STATE === stateDir({}, HOME)) { console.error("--test needs CHAMBERLAIN_CONF and CHAMBERLAIN_STATE pointed at scratch directories, never the live ones"); process.exit(2); }
}
let cfg;
try { cfg = loadConfig(CONF); } catch (e) { console.error(String((e as Error).message)); process.exit(2); }
if (TEST && !["127.0.0.1", "::1"].includes(cfg.host)) { console.error("--test binds to loopback only"); process.exit(2); }

const store = defaultStore();
const log = makeLog(store, { src: "queue-web" });
const privateFile = (name: string) => readPrivateFile(CONF, name);
// The daemon raises alarms; the page only logs them, so a page problem never alerts the principal twice.
// Refuse a file from a newer Chamberlain, and upgrade older ones, before anything reads them.
startup({ migrate: true, log });
maintain(store);
const alarm = (key: string, title: string) => log("alarm", { key, title });
const qs = cfg.decisionsServer;
// Cards waiting in any thread on any server, shown on the queue; answerable where the server's adapter can answer and was
// granted rights. The Decisions server's comes from web.json (decisionsServer), the others' from web.json's answerTokens; any
// server without one is read-only. servers.json is read again on every poll, and an adapter is kept while its entry is unchanged.
const pool = new Map<string, { key: string; adapter: Adapter }>();
const servers = (): ServerAdapter[] => {
	try {
		// Answer rights come only from web.json. Any operateTokenFile a servers.json entry carries is dropped.
		const list: ServerEntry[] = withAnswerRights(loadServers(CONF), qs, cfg.answerTokens);
		const out = list.map((server) => {
			const key = JSON.stringify(server);
			let held = pool.get(server.name);
			if (!held || held.key !== key) { held = { key, adapter: makeAdapter(server, { conf: CONF, state: STATE, store, log, alarm: (k, t) => alarm(k, t) }) }; pool.set(server.name, held); }
			return { server, adapter: held.adapter };
		});
		for (const name of pool.keys()) if (!list.some((x) => x.name === name)) pool.delete(name);
		return out;
	} catch (e) { log("mirror-servers-error", { error: String(e).slice(0, 200) }); return []; }
};
const mirror = TEST ? undefined : createWaiting({
	store, servers,
	// The Decisions thread is never mirrored: its own views carry the queue.
	skipThreads: () => [privateFile("decisions-thread")].filter((x): x is string => Boolean(x)), links: cfg.mirrorLinks, log });
const hostPort = cfg.host.includes(":") ? `[${cfg.host}]:${cfg.port}` : `${cfg.host}:${cfg.port}`;
const app = createApp({
	store, state: STATE, log,
	// A thread-routed answer goes to its thread through its server's adapter (`send`), where it has the rights; test mode sends nothing.
	sendToThread: TEST ? undefined : threadSender(servers),
	hosts: [hostPort, ...(cfg.allowedHosts ?? []).flatMap((h) => [h, `${h}:${cfg.port}`])], threadLinks: cfg.threadLinks,
	staticDir: new URL("./static", import.meta.url).pathname, testMode: TEST, mirror,
});
const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch });
// The Decisions thread title shows the open count, on the server that hosts that thread and whose adapter can set a title;
// until the rights are there it keeps its fixed title.
const decisions = privateFile("decisions-thread");
const titled = qs && decisions ? servers().find((x) => x.server.origin === qs.origin && has(x.adapter, "setTitle")) : undefined;
const keepTitle = !TEST && titled && has(titled.adapter, "setTitle") ? titleKeeper(app.openCount, (title) => titled.adapter.setTitle!(title), log) : undefined;
log("web-start", { host: cfg.host, port: server.port, test: TEST, title: keepTitle ? "live" : "fixed" });
console.log(`Chamberlain decision queue on http://${hostPort}${TEST ? " (test mode: no wakes)" : ""}`);

const tick = async () => {
	try { await app.recover(); } catch (e) { log("recover-error", { error: String(e) }); }
};
// Startup recovery: every page claim whose wake is neither delivered nor in the outbox is written to the outbox now.
await tick();
log("startup-recovered");
setInterval(tick, 60_000);
// The mirror reads first, so the title counts mirrored cards from its first rename.
const pollMirror = async () => { try { await mirror?.poll(); } catch (e) { log("mirror-error", { error: String(e).slice(0, 200) }); } };
await pollMirror();
if (mirror) setInterval(pollMirror, 15_000);
if (keepTitle) { await keepTitle(); setInterval(keepTitle, 15_000); }
