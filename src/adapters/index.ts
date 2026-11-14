/**
 * The adapter registry. Adding a backend is one new folder under src/adapters/ and one line here:
 *
 *   myBackend: myBackendEntry,
 *
 * A server in servers.json picks its adapter by name (`"adapter": "t3"`, the default). The core never imports this file's
 * adapters directly: it is handed an Adapter, and only the entry points (daemon, page, tools) read the registry.
 */
import { CONF, STATE } from "../core/config.ts";
import type { Adapter, AdapterEntry, AdapterEnv } from "../core/adapter.ts";
import { privateFile } from "../core/private.ts";
import { homeServer, readServers, type ServerEntry } from "../core/servers.ts";
import { defaultT3Server, t3Entry } from "./t3/index.ts";

export const ADAPTERS: Record<string, AdapterEntry> = {
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

/** servers.json, or one T3 server named "local" at CHAMBERLAIN_T3_ORIGIN with its token in `read-token`. */
export const loadServers = (conf = CONF): ServerEntry[] => readServers(conf) ?? [defaultT3Server()];

export type EnvParts = {
	conf?: string;
	state?: string;
	store?: AdapterEnv["store"];
	log?: AdapterEnv["log"];
	alarm?: AdapterEnv["alarm"];
};
/** The environment an adapter for `server` runs in: the directories, the Steward's thread, and the private files. */
export function adapterEnv(server: ServerEntry, p: EnvParts = {}): AdapterEnv {
	const conf = p.conf ?? CONF;
	return {
		server,
		conf,
		state: p.state ?? STATE,
		...(p.store ? { store: p.store } : {}),
		log: p.log ?? (() => {}),
		alarm: p.alarm ?? (() => {}),
		steward: () => privateFile(conf, "steward-thread"),
		readPrivate: (name) => privateFile(conf, name),
	};
}

/** One adapter for one server entry, by the name the entry gives. */
export const makeAdapter = (server: ServerEntry, p: EnvParts = {}): Adapter =>
	adapterEntry(server.adapter).create(adapterEnv(server, p));

/** The server the Steward runs on and its adapter: what wakes, the busy check and `ask` go through. */
export function homeAdapter(p: EnvParts = {}): { server: ServerEntry; adapter: Adapter } {
	const server = homeServer(loadServers(p.conf));
	return { server, adapter: makeAdapter(server, p) };
}
