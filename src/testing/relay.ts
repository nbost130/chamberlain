/**
 * The daemon's relay for tests that drive a producer (the page, the engine) and want to see what reaches the webhook. `drain` runs passes
 * the way the running daemon would, until nothing is pending or the attempts are used. It is for tests only: it takes a stubbed-kernel lock
 * (lock.ts), it refuses to run unless NODE_ENV or BUN_ENV is "test" (or CHAMBERLAIN_TEST_ONLY=1: src/core/test-env.ts), and
 * src/architecture.test.ts fails if production code imports anything from src/testing/.
 */
import type { WakeTransport } from "../core/deliver.ts";
import { recordAnswerDelivered } from "../core/questions-wake.ts";
import { createRelay } from "../core/relay.ts";
import type { RelayDeps } from "../core/relay-ctx.ts";
import type { Store } from "../core/store.ts";
import { requireTestEnv } from "../core/test-env.ts";
import { testRelayLock } from "./lock.ts";

export function testRelay(store: Store, wake: WakeTransport, o: Partial<RelayDeps> = {}) {
	requireTestEnv("testRelay");
	const relay = createRelay({
		store,
		lock: testRelayLock(store),
		wake,
		gate: () => "idle",
		log: () => {},
		alarm: () => {},
		retryAfterMs: () => 0,
		maxAttempts: 3,
		onDelivered: (id) => recordAnswerDelivered(store, id),
		...o,
	});
	const drain = async () => {
		for (let i = 0; i < 3 && store.wakes.rows().length + store.wakes.held().length > 0; i++) await relay.pass();
	};
	return { relay, drain };
}

/** A wake that was delivered at `at`: a delivered row, as the relay leaves it. */
export function deliveredRow(store: Store, deliveryId: string, at: number) {
	store.wakes.enqueue({ deliveryId, message: "m", queuedAt: at });
	store.wakes.finish(store.wakes.find(deliveryId)!.id, "delivered", at);
}
