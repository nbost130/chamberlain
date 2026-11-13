/**
 * A process that opens the default store with a chmod that always fails, for src/core/modes.test.ts: it shows what an entry point does when the
 * database or its directory cannot be made private. Usage: bun src/testing/mode-probe.ts <state directory>
 * Expected: exit 4 and the reason on stderr, with no stack trace.
 */
import { defaultStore } from "../core/default-store.ts";

defaultStore(process.argv[2]!, [], { chmod: () => { throw Error("EPERM: operation not permitted"); } });
console.log("opened");
