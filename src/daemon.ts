/**
 * Chamberlain's daemon: the engine (src/core/engine.ts) wired to the real world. Every server in servers.json is served
 * by the adapter it names (src/adapters/index.ts); the Steward's own server's adapter wakes the Steward.
 * Config dir: ~/.config/chamberlain/ (CHAMBERLAIN_CONF), state dir: ~/.local/state/chamberlain/ (CHAMBERLAIN_STATE).
 * It is the one relay that sends wakes (core/relay.ts), so one daemon runs per state directory: a second exits 5 (core/singleton.ts).
 */
import { CONF, STATE } from "./core/config.ts";
import { defaultStore } from "./core/default-store.ts";
import { createEngine } from "./core/engine.ts";
import { ghRead } from "./core/gh.ts";
import { maintain } from "./core/maintain.ts";
import { makeLog } from "./core/log.ts";
import { startup } from "./core/migrate.ts";
import { holdRelayLock, networkFilesystem, RelayDatabaseLinkedError, RelayLockUnavailableError, RelayRunningError, type RelayLock } from "./core/singleton.ts";
import { adapterNames, loadServers, makeAdapter } from "./adapters/index.ts";

const store = defaultStore();
const log = makeLog(store);
// The relay's flock on the state directory, held for this process's life: the operating system lets one process hold it, and frees it when this one dies.
let lock: RelayLock;
try { lock = holdRelayLock(store.path); } catch (e) {
	if (e instanceof RelayLockUnavailableError) {
		console.error(`chamberlain: ${e.message}`);
		log("relay-lock-unavailable", { error: e.message.slice(0, 200) });
		process.exit(1);
	}
	if (e instanceof RelayDatabaseLinkedError) {
		console.error(`chamberlain: ${e.message}`);
		log("relay-database-linked", { db: e.db, links: e.links });
		process.exit(1);
	}
	if (!(e instanceof RelayRunningError)) throw e;
	console.error(`chamberlain: ${e.message}`);
	log("relay-refused", { lock: e.lock });
	process.exit(5);
}
const netfs = networkFilesystem(STATE);
if (netfs) {
	console.error(`chamberlain: warning: the state directory is on a network filesystem (${netfs}). SQLite and the one-relay lock are not reliable there; this is unsupported. Use a local directory (CHAMBERLAIN_STATE).`);
	log("state-on-network-filesystem", { fs: netfs });
}
// Refuse a file from a newer Chamberlain, and upgrade older ones, before anything reads them.
startup({ migrate: true, log });
maintain(store);
setInterval(() => { try { maintain(store); } catch (e) { log("maintain-error", { error: String(e).slice(0, 200) }); } }, 24 * 3600_000);

/** Adapters are made before the engine that raises their alarms, so the alarm is bound once the engine exists. */
let raise: (key: string, title: string, summary: string) => void = () => {};
const servers = loadServers(CONF).map((server) => ({ server, adapter: makeAdapter(server, { conf: CONF, state: STATE, store, log, alarm: (k, t, s) => raise(k, t, s) }) }));

const engine = createEngine({
	conf: CONF,
	lock,
	store,
	servers,
	dry: process.env.CHAMBERLAIN_DRY === "1",
	// Stalled-thread recovery is OFF until CHAMBERLAIN_RECOVER=1 (src/core/recover.ts): merging it changes nothing until it is turned on.
	recover: process.env.CHAMBERLAIN_RECOVER === "1",
	exclude: (process.env.CHAMBERLAIN_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
	log,
	sweepPromptFile: new URL("../docs/steward-sweep-prompt.md", import.meta.url).pathname,
	// The held ledger closes holds whose PR, issue or branch is done (src/core/hold-reconcile.ts).
	gh: ghRead,
	// The Steward-health hand-off question goes through ask.ts like any other, asked only when the adapter cannot start the hand-off itself.
	ask: async (raw) => {
		const child = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, JSON.stringify(raw)], { stdout: "ignore", stderr: "ignore" });
		if (await child.exited !== 0) throw Error("steward-health ask failed; queue checked again on retry");
	},
});
raise = engine.alarm;
log("adapters", { registered: adapterNames(), serving: servers.map((x) => `${x.server.name}:${x.server.adapter}`) });
await engine.start();
