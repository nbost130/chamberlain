/** A real Store on an in-memory database, for tests. The same implementation the daemon runs on; there is no fake. */
import { openStore } from "../core/store/sqlite-store.ts";
import type { Store } from "../core/store/store.ts";

export const memStore = (): Store => openStore(":memory:");
