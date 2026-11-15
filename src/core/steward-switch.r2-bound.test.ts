/**
 * Sol R2 (split PR A): oversized transfers never POST — atomic quarantine, send-gate refuse, retry refuse.
 * Probes fail at ca9236f (30k-byte POST); pass with the send-path bound.
 */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../testing/lock.ts";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { createRelay } from "./relay.ts";
import { TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";

const { confWorld, memStoreSeeded } = useStewardSwitchFixtures();

describe("R2 encoded bound at every send path", () => {
	for (const scenario of ["failed-finish", "retry"] as const) {
		test(`oversized transfer stays unsent after ${scenario} (Sol probe)`, async () => {
			const w = confWorld();
			const base = memStoreSeeded(w.conf);
			const id = "transfer:oversized:g1";
			const big = "界".repeat(10_000);
			expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
			base.wakes.hold({ deliveryId: id, message: big, queuedAt: 1, kind: "transfer" });
			let fail = scenario === "failed-finish";
			const store = {
				...base,
				wakes: {
					...base.wakes,
					finish: (...args: Parameters<typeof base.wakes.finish>) => {
						if (fail && args[1] === "dead_letter") throw new Error("injected finish failure after durable compose");
						return base.wakes.finish(...args);
					},
				},
			};
			const posts: { id: string; bytes: number }[] = [];
			const relay = createRelay({
				store,
				lock: testRelayLock(store),
				gate: () => "idle",
				log: () => {},
				alarm: () => {},
				wake: {
					ready: () => true,
					send: async (deliveryId, message) => {
						posts.push({ id: deliveryId, bytes: Buffer.byteLength(message) });
						return { ok: true, status: 202 };
					},
				},
			});
			try {
				await relay.pass();
			} catch (e) {
				if (!fail) throw e;
			}
			if (scenario === "retry") {
				expect(base.wakes.find(id)?.status).toBe("dead_letter");
				expect(base.wakes.retry(id)).toBe("oversized");
				expect(base.wakes.find(id)?.status).toBe("dead_letter");
			} else {
				// Atomic quarantine: finish failure rolls compose back — still held, never pending oversized.
				expect(base.wakes.find(id)).toBeUndefined();
				expect(base.wakes.held().some((h) => h.deliveryId === id)).toBe(true);
			}
			fail = false;
			await relay.pass();
			expect(posts).toEqual([]);
			expect(base.wakes.find(id)?.status).toBe("dead_letter");
		});
	}

	test("send path dead-letters a pending oversized row left by a prior gap", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = "transfer:pending-over:g1";
		const big = "界".repeat(10_000);
		// Simulate the pre-fix gap: oversized already pending (compose committed, finish never ran).
		s.wakes.enqueue({ deliveryId: id, message: big, queuedAt: 1, kind: "transfer" });
		expect(s.wakes.find(id)?.status).toBe("pending");
		const posts: string[] = [];
		const alarms: string[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: (k) => alarms.push(k),
			wake: {
				ready: () => true,
				send: async (deliveryId) => {
					posts.push(deliveryId);
					return { ok: true, status: 202 };
				},
			},
		});
		await relay.pass();
		expect(posts).toEqual([]);
		expect(s.wakes.find(id)?.status).toBe("dead_letter");
		expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(true);
	});
});
