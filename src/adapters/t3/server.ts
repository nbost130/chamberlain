/** A servers.json entry served by the T3 adapter: the core's entry plus the two keys T3 needs. */
import type { ServerEntry } from "../../core/servers.ts";

export type T3Server = ServerEntry & {
	/** The T3 server's origin: "http://127.0.0.1:3773". */
	origin: string;
	/** File in the config directory holding a read-only (orchestration:read) token. */
	tokenFile: string;
};

/** The entry as a T3 server, or an error naming what it lacks. */
export function t3Server(s: ServerEntry): T3Server {
	if (typeof s.origin !== "string" || !s.origin || typeof s.tokenFile !== "string" || !s.tokenFile) throw Error(`servers.json: ${s.name}: a t3 server needs origin and tokenFile`);
	return s as T3Server;
}
