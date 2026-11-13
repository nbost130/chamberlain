/**
 * Wakes that stopped sending: `bun src/wakes.ts list`, `bun src/wakes.ts retry <delivery id>`, `bun src/wakes.ts cancel <delivery id>`.
 * The logic is src/core/wakes-cli.ts. Works on the database directly; the daemon's relay picks a retry up on its next pass.
 * Exits 0 done, 1 no row has that id (or it is in the wrong state), 2 usage, 3 a database from a newer build, 4 a database or directory that is not private.
 */
import { defaultStore } from "./core/default-store.ts";
import { runWakesCli } from "./core/wakes-cli.ts";

const store = defaultStore();
try { process.exitCode = runWakesCli(store, process.argv.slice(2), (l) => console.log(l)); } finally { store.close(); }
