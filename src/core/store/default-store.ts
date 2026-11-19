/**
 * The database an entry point (a command-line tool, the daemon, the page) opens: `<state>/chamberlain.db`, migrated to this
 * build's schema. A database from a newer Chamberlain exits 3 with the reason, as migrate.ts's startup() does for a config
 * file; one whose database or directory cannot be made private (mode 0600 and 0700) exits 4. Library code takes a Store instead.
 */

import { existsSync } from "node:fs";
import { STATE } from "../config/config.ts";
import { InsecureModeError } from "../private.ts";
import { SchemaTooNewError } from "./schema.ts";
import { type OpenOptions, openStore, openStoreReadOnly } from "./sqlite-store.ts";
import { dbPath, type Store } from "./store.ts";

export function defaultStore(state = STATE, open: OpenOptions = {}): Store {
	try {
		return openStore(dbPath(state), open);
	} catch (e) {
		if (e instanceof SchemaTooNewError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(3);
		}
		// A database or directory that is not private enough exits 4 with the reason, before anything is stored in it.
		if (e instanceof InsecureModeError) {
			console.error(`chamberlain: ${e.message}`);
			process.exit(4);
		}
		throw e;
	}
}

/**
 * The same database, opened to read only. It must already exist; a missing, newer, older or unreadable file throws (the caller fails closed), and
 * nothing is created, migrated, chmodded or locked for writing. For the tools that only look (`chamberlain decisions show|verify`).
 */
export function readOnlyStore(state = STATE): Store {
	const path = dbPath(state);
	if (!existsSync(path)) throw new Error(`no database at ${path}`);
	return openStoreReadOnly(path);
}
