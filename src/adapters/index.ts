/**
 * The adapter registry. Adding a backend is one new folder under src/adapters/ and one line here:
 *
 *   myBackend: myBackendEntry,
 *
 * A server in servers.json picks its adapter by name (`"adapter": "t3"`, the default). The core never imports this file's
 * adapters directly: it is handed an Adapter, and only the entry points (daemon, page, tools) read the registry.
 */

import type { Adapter, AdapterEntry, AdapterEnv } from "../core/adapter/adapter.ts";
import { CONF, STATE } from "../core/config/config.ts";
import { readNamed, thread } from "../core/config/layout.ts";
import { homeServer, readServers, type ServerEntry } from "../core/config/servers.ts";
import { defaultT3Server, t3Entry } from "./t3/index.ts";

const ADAPTERS: Record<string, AdapterEntry> = {
	t3: t3Entry,
};

/** The registered adapter names, for messages. */
export const adapterNames = () => Object.keys(ADAPTERS);

/** The entry for a name, or an error that lists the registered ones. */
export function adapterEntry(name: string): AdapterEntry {
	const e = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
	if (!e) throw Error(`unknown adapter "${name}" (registered: ${adapterNames().join(", ")})`);
	return e;
}

/** The `servers` list of config.json, or one T3 server named "local" at `t3Origin` (CHAMBERLAIN_T3_ORIGIN) with its token in the `read-token` secret. */
export const loadServers = (conf = CONF): ServerEntry[] => readServers(conf) ?? [defaultT3Server()];

export type EnvParts = {
	conf?: string;
	state?: string;
	store?: AdapterEnv["store"];
	log?: AdapterEnv["log"];
	alarm?: AdapterEnv["alarm"];
};
/** The environment an adapter for `server` runs in: the directories, the Steward's thread, and the private files. */
function adapterEnv(server: ServerEntry, p: EnvParts = {}): AdapterEnv {
	const conf = p.conf ?? CONF;
	const store = p.store;
	return {
		server,
		conf,
		state: p.state ?? STATE,
		...(store ? { store } : {}),
		log: p.log ?? (() => {}),
		alarm: p.alarm ?? (() => {}),
		// MAX(gen)'s thread when generations exist; else config.json threads.steward. Shared *.steward names are never read.
		steward: () => store?.steward.current()?.thread ?? thread(conf, "steward"),
		readPrivate: (name) => readGenPrivate(conf, store, name),
	};
}

/** Resolve wake-url / compact-url from the current generation's immutable refs when seeded. */
function readGenPrivate(conf: string, store: AdapterEnv["store"] | undefined, name: string): string | undefined {
	if (store && (name === "wake-url" || name === "compact-url")) {
		const g = store.steward.current();
		if (g) {
			const ref = name === "wake-url" ? g.wakeRef : g.compactRef;
			return ref ? readNamed(conf, ref) : undefined;
		}
	}
	return readNamed(conf, name);
}

/** One adapter for one server entry, by the name the entry gives. */
export const makeAdapter = (server: ServerEntry, p: EnvParts = {}): Adapter =>
	adapterEntry(server.adapter).create(adapterEnv(server, p));

/** The server the Steward runs on and its adapter: what wakes, the busy check and `ask` go through. */
export function homeAdapter(p: EnvParts = {}): { server: ServerEntry; adapter: Adapter } {
	const server = homeServer(loadServers(p.conf));
	return { server, adapter: makeAdapter(server, p) };
}
