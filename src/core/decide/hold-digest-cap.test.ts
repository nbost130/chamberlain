/**
 * Held-wake digests split at compose time under TRANSFER_DIGEST_MAX_BYTES (same bound as transfer replay).
 */
import { describe, expect, test } from "bun:test";
import { testRelayLock } from "../../testing/lock.ts";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { createRelay } from "../delivery/relay.ts";
import { encodedSendBytes, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import { composeWake } from "./hold.ts";
import { composeDigestBatch, TRANSFER_WRAP_RESERVE_BYTES } from "./hold-digest-batch.ts";

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

describe("held digest byte cap at compose", () => {
	test("composeDigestBatch: four ~11k turn_ended wakes split — no single POST over cap", async () => {
		const parts = [1, 2, 3, 4].map((n) => ({
			deliveryId: `mcp:launch:test:ended:${n}`,
			message: `[chamberlain] turn_ended: thread "t${n}" finished.\n${"y".repeat(11_000)}`,
			queuedAt: n,
			kind: "turn_ended" as const,
			thread: `thread-${n}`,
		}));
		const all = composeWake(parts, 1);
		expect(encodedSendBytes(all.message, all.deliveryId)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);

		const batch = composeDigestBatch(parts, 1)!;
		expect(encodedSendBytes(batch.message, batch.deliveryId)).toBeLessThanOrEqual(TRANSFER_DIGEST_MAX_BYTES);
		expect(batch.members.length).toBeLessThan(4);
		expect(batch.members.length).toBeGreaterThan(0);

		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		for (const p of parts) s.wakes.hold(p);

		const posts: { id: string; messageBytes: number }[] = [];
		const relay = createRelay({
			store: s,
			lock: testRelayLock(s),
			gate: () => "idle",
			log: () => {},
			alarm: () => {},
			wake: recordingWake(posts),
			now: () => 100,
		});
		await relay.pass();
		expect(posts.length).toBeGreaterThanOrEqual(1);
		expect(posts.every((p) => p.messageBytes <= TRANSFER_DIGEST_MAX_BYTES)).toBe(true);
		expect(s.wakes.find(all.deliveryId)).toBeUndefined();
		expect(s.wakes.held(null).length).toBeGreaterThan(0);

		await relay.pass();
		expect(posts.every((p) => p.messageBytes <= TRANSFER_DIGEST_MAX_BYTES)).toBe(true);
	});

	test("solo held wake over cap: dead-letter with digest-oversized alarm, no POST", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = "mcp:launch:solo:ended:1";
		const message = "x".repeat(23_970);
		expect(encodedSendBytes(message, id)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
		s.wakes.hold({ deliveryId: id, message, queuedAt: 1, kind: "turn_ended", thread: "t" });

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
		expect(alarms.some((a) => a.includes("digest-oversized"))).toBe(true);
	});

	test("send gate on legacy pending digest: digest-oversized alarm, not transfer", async () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf);
		const id = "digest:legacy-over";
		const message = "界".repeat(7990);
		expect(encodedSendBytes(message, id)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
		s.wakes.enqueue({ deliveryId: id, message, queuedAt: 1, kind: "digest" });

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
		expect(alarms.some((a) => a.includes("digest-oversized"))).toBe(true);
		expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(false);
	});
});

describe("digest budget for answers", () => {
	const item = (id: string, kind: string, bytes: number, queuedAt: number) => ({
		deliveryId: id,
		message: "x".repeat(bytes),
		queuedAt,
		kind,
	});

	test("a digest of several wakes leaves room for a transfer header; a lone wake may use the full cap", () => {
		const half = Math.floor((TRANSFER_DIGEST_MAX_BYTES - TRANSFER_WRAP_RESERVE_BYTES) / 2);
		const two = [item("a", "answer", half, 1), item("b", "answer", half, 2)];
		// Together they would fit the full cap, but not the cap less the transfer reserve: only the first goes.
		expect(composeDigestBatch(two, 10)!.members).toEqual(["a"]);
		const big = item("c", "turn_ended", TRANSFER_DIGEST_MAX_BYTES - 1024, 1);
		expect(composeDigestBatch([big], 10)!.members).toEqual(["c"]);
	});

	test("answers are admitted before older wakes, so the answer whose deadline forced the digest is in it", () => {
		const old = item("old", "turn_ended", TRANSFER_DIGEST_MAX_BYTES - TRANSFER_WRAP_RESERVE_BYTES - 1500, 1);
		const answer = item("ans", "answer", 2000, 5);
		const batch = composeDigestBatch([old, answer], 10)!;
		expect(batch.members).toEqual(["ans"]);
	});
});
