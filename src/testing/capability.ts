/** Capabilities for tests of the page (src/core/capability.ts). */
import { makeCapability, type Capability } from "../core/capability.ts";
import { requireTestEnv } from "../core/test-env.ts";

/**
 * A capability that accepts every request, for the tests that are about something other than who may ask. It refuses to be built outside a
 * test run, so a page in production cannot be given it; src/web/capability.test.ts holds the tests that use a real one.
 */
export function openCapability(): Capability {
	requireTestEnv("openCapability");
	return {
		accepts: () => true,
		acceptsView: () => false,
		acceptsCookie: () => true,
		grant: () => "dq_cap=test; Path=/",
	};
}

/** A real capability over a token the test holds, and the clock it moves: `{ token }` can be reassigned to rotate it. */
export function memoryCapability(
	token: string | undefined,
	clock: { now: number } = { now: Date.now() },
	viewKey?: string,
) {
	const state = { token, viewKey };
	return {
		state,
		clock,
		capability: makeCapability(
			() => state.token,
			() => clock.now,
			() => state.viewKey,
		),
	};
}
