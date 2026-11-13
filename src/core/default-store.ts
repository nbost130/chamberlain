/**
 * The database an entry point (a command-line tool, the daemon, the page) opens: `<state>/chamberlain.db`, migrated to this
 * build's schema. A database from a newer Chamberlain exits 3 with the reason, as migrate.ts's startup() does for a config
 * file; one whose database or directory cannot be made private (mode 0600 and 0700) exits 4. Library code takes a Store instead.
 *
 * For the default state directory only, a database an earlier build left in the cache directory is moved here first, once
 * (state-dir.ts), and the move is logged: to stderr and, as the event `state-moved`, in the database's own log.
 */
import { STATE } from "./config.ts";
import { InsecureModeError } from "./private.ts";
import { SchemaTooNewError } from "./schema.ts";
import { openStore, type OpenOptions } from "./sqlite-store.ts";
import { legacyCacheDirs, moveStateOutOfCache } from "./state-dir.ts";
import { dbPath, type Store } from "./store.ts";

export function defaultStore(state = STATE, legacy: readonly string[] = state === STATE ? legacyCacheDirs(process.env, process.env.HOME!) : [], open: OpenOptions = {}): Store {
	try {
		const moved = moveStateOutOfCache(state, legacy);
		if (moved) console.error(`chamberlain: moved the database from ${moved.from} to ${moved.to} (${moved.moved.join(", ")}); the cache directory is no place for rulings and the decision log`);
		const store = openStore(dbPath(state), open);
		if (moved) store.events.append({ t: new Date().toISOString(), event: "state-moved", from: moved.from, to: moved.to, moved: moved.moved });
		return store;
	} catch (e) {
		if (e instanceof SchemaTooNewError) { console.error(`chamberlain: ${e.message}`); process.exit(3); }
		// A database or directory that is not private enough exits 4 with the reason, before anything is stored in it.
		if (e instanceof InsecureModeError) { console.error(`chamberlain: ${e.message}`); process.exit(4); }
		throw e;
	}
}
