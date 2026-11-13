/**
 * A relay lock for tests that build a relay or an engine in-process (src/core/relay.ts and engine.ts require one). It is a REAL handle
 * (`isRelayLock` accepts it, it records the file's device and inode, `held()` turns false on `release()`) whose kernel `flock` is not taken
 * (singleton.ts `holdTestRelayLock`), since hundreds of in-process tests cannot all contend for one real lock. It is bound to the store it is
 * given exactly as a real handle is bound to a database file, so a relay built over a different store still refuses it; with no store it is
 * bound to an in-memory store. The scenarios that need the real lock use real processes (src/core/singleton.test.ts). Never imported by production code: src/architecture.test.ts fails if anything outside src/testing/ imports this folder.
 */
import { holdTestRelayLock, type RelayLock } from "../core/singleton.ts";
import type { Store } from "../core/store.ts";

/** A held test lock for `store` (an in-memory store when none is given). Call `.release()` to test a relay that has lost its lock. */
export function testRelayLock(store?: Pick<Store, "path">): RelayLock {
	return holdTestRelayLock(store?.path ?? ":memory:");
}
