/**
 * The `servers` list of config.json (once servers.json: `{"schemaVersion": 2, "servers": [...]}`): the servers Chamberlain watches, each
 * served by one adapter (src/adapters/). Version 1 had no `adapter` (every server was T3 Code); it is still read, as `adapter: "t3"`.
 */
import { CONF } from "./config.ts";
import { cfg } from "./layout.ts";
import { checkVersion, SCHEMA_VERSION } from "./schema.ts";

/** The adapter a server entry names when it names none: every server was T3 Code before adapters existed. */
export const DEFAULT_ADAPTER = "t3";

export type ServerEntry = {
	/** A short name used in wakes, queue items and logs: "main", "laptop". */
	name: string;
	/** Which adapter serves this server: a name in the registry (src/adapters/index.ts). Default "t3". */
	adapter: string;
	/** Set for a server that is not the one the Steward runs on: the id the woken thread passes to its own tools. */
	environmentId?: string;
	/** A laptop that is often asleep: no alarm when its connection stays down. */
	mayBeOffline?: boolean;
	/** `user@host` reachable by key-based ssh, so `git` can be asked about a worktree path that lives on that machine. */
	sshHost?: string;
	/** File holding an operate-rights token. Only the queue page grants it (web.json); an entry's own value is dropped there. */
	operateTokenFile?: string | null;
	/**
	 * Everything else is the adapter's: the T3 adapter reads `origin` (its server's origin) and `tokenFile` (a file in
	 * the config directory with a read-only token); another adapter reads whatever keys it documents.
	 */
	[adapterOption: string]: unknown;
};

/** Pure: the entries of a parsed servers.json. Throws on a newer schema or a malformed entry. */
export function parseServers(raw: unknown): ServerEntry[] {
	const list =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (checkVersion("servers.json", (raw as { schemaVersion?: unknown }).schemaVersion),
				(raw as { servers?: unknown }).servers)
			: undefined;
	if (!Array.isArray(list)) throw Error('servers.json: need {"schemaVersion": 2, "servers": [{name, adapter, ...}]}');
	const names = new Set<string>();
	for (const x of list as Partial<ServerEntry>[]) {
		if (!x || typeof x !== "object" || typeof x.name !== "string" || !x.name)
			throw Error("servers.json: every server needs a name");
		if (x.adapter !== undefined && (typeof x.adapter !== "string" || !x.adapter.trim()))
			throw Error(`servers.json: ${x.name}: adapter must be a non-empty string`);
		if (names.has(x.name)) throw Error(`servers.json: two servers are named ${x.name}`);
		names.add(x.name);
	}
	return (list as Partial<ServerEntry>[]).map((x) => ({
		...x,
		adapter: x.adapter?.trim() || DEFAULT_ADAPTER,
	})) as ServerEntry[];
}

export const serversDoc = (servers: ServerEntry[]) => ({ schemaVersion: SCHEMA_VERSION, servers });

/** The `servers` list of config.json (else the legacy servers.json), parsed, or `undefined` when neither has one. */
export function readServers(conf = CONF): ServerEntry[] | undefined {
	const list = cfg(conf, "servers");
	return list === undefined ? undefined : parseServers({ schemaVersion: SCHEMA_VERSION, servers: list });
}

/** The server the Steward runs on: the one with no `environmentId`, else the first. Its adapter wakes the Steward. */
export function homeServer(servers: ServerEntry[]): ServerEntry {
	const home = servers.find((x) => !x.environmentId) ?? servers[0];
	if (!home) throw Error("servers.json lists no servers");
	return home;
}
