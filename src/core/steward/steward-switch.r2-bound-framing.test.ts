/**
 * Sol #64 R2: bound is finalSendMessage (body + delivery-id trailer), not the stored body alone.
 * Four boundary cases that POSTed framed-over-cap payloads at 8104fef (23,970 stored → 24,060+ framed).
 * Transport records the framed message the relay hands it (same bytes webhookWake would JSON-wrap).
 */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../../testing/lock.ts";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { composeWake } from "../decide/hold.ts";
import { createRelay } from "../delivery/relay.ts";
import { composeTransferBatch } from "./steward-transfer.ts";
import { encodedSendBytes, TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";

const { confWorld, memStoreSeeded } = useStewardSwitchFixtures();

function recordingWake(posts: { id: string; messageBytes: number }[]) {
	return {
		ready: () => true,
		send: async (id: string, message: string) => {
			posts.push({ id, messageBytes: Buffer.byteLength(message, "utf8") });
			return { ok: true, status: 202 };
		},
	};
}

describe("R2 wire bound includes delivery-id trailer", () => {
	for (const mode of ["held", "pending", "retry"] as const) {
		test(`boundary ${mode}: 23,970-byte body framed over cap — no POST`, async () => {
			const w = confWorld();
			const s = memStoreSeeded(w.conf);
			const id = "transfer:boundary:g1";
			const row = { deliveryId: id, message: "界".repeat(7990), queuedAt: 1, kind: "transfer" as const };
			expect(Buffer.byteLength(row.message)).toBe(23_970);
			expect(encodedSendBytes(row.message, id)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);

			if (mode === "held") s.wakes.hold(row);
			else s.wakes.enqueue(row);
			if (mode === "retry") {
				s.wakes.finish(s.wakes.find(id)!.id, "dead_letter", 2);
				expect(s.wakes.retry(id)).toBe("oversized");
			}

			const posts: { id: string; messageBytes: number }[] = [];
			const alarms: string[] = [];
			const relay = createRelay({
				store: s,
				lock: testRelayLock(s),
				gate: () => "idle",
				log: () => {},
				alarm: (k) => alarms.push(k),
				wake: recordingWake(posts),
				now: () => 1,
			});
			await relay.pass();
			expect(posts).toEqual([]);
			expect(s.wakes.find(id)?.status).toBe("dead_letter");
			// Held/pending hit the send/quarantine gate (alarm). Retry refusal leaves dead_letter without a pass.
			if (mode !== "retry") expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(true);
		});
	}

	test("boundary digest: two-item composeWake at 23,970 framed over cap is never admitted or POSTed", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const parts = [
			{ deliveryId: "transfer:boundary:g1", message: "x".repeat(11_000), queuedAt: 1, kind: "transfer" as const },
			{
				deliveryId: "transfer:boundary2:g1",
				message: "x".repeat(11_000),
				queuedAt: 1,
				kind: "transfer" as const,
			},
		];
		parts[0]!.message += "x".repeat(23_970 - Buffer.byteLength(composeWake(parts, 1).message));
		const dig = composeWake(parts, 1);
		expect(Buffer.byteLength(dig.message)).toBe(23_970);
		expect(encodedSendBytes(dig.message, dig.deliveryId)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
		// Cap uses final framing: batch must not admit both into one over-cap digest.
		const batch = composeTransferBatch(parts, 1)!;
		expect(batch.members).toEqual(["transfer:boundary:g1"]);
		expect(encodedSendBytes(batch.message, batch.deliveryId)).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);

		for (const p of parts) s.wakes.hold(p);
		const posts: { id: string; messageBytes: number }[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			wake: recordingWake(posts),
			now: () => 1,
		});
		await relay.pass();
		expect(posts.every((p) => p.messageBytes <= TRANSFER_DIGEST_MAX_BYTES)).toBe(true);
		expect(posts.some((p) => p.id === dig.deliveryId)).toBe(false);
		expect(s.wakes.find(dig.deliveryId)).toBeUndefined();
	});
});
