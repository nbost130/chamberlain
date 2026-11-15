/**
 * Sol #64 R3: refused oversized retry is distinct from success; CLI exits non-zero and never promises a send.
 */
import { expect, test } from "bun:test";
import { testRelayLock } from "../testing/lock.ts";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { createRelay } from "./relay.ts";
import { TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";
import { runWakesCli } from "./wakes-cli.ts";

const { confWorld, diskStore } = useStewardSwitchFixtures();

test("oversized persisted pending row: reopen refuse, then wakes retry exits non-zero", async () => {
	const w = confWorld();
	let s = diskStore(w.state);
	const id = "transfer:restart:g1";
	s.wakes.enqueue({ deliveryId: id, message: "界".repeat(10_000), queuedAt: 1, kind: "transfer" });
	s.close();
	s = diskStore(w.state);
	const posts: string[] = [];
	const alarms: string[] = [];
	const r = createRelay({
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
	await r.pass();
	expect(posts).toEqual([]);
	expect(s.wakes.find(id)?.status).toBe("dead_letter");
	expect(alarms.some((a) => a.includes("transfer-oversized"))).toBe(true);

	const output: string[] = [];
	const rc = runWakesCli(s, ["retry", id], (v) => output.push(v), {});
	expect(rc).not.toBe(0);
	expect(s.wakes.find(id)?.status).toBe("dead_letter");
	expect(output.join("\n")).toContain(`${TRANSFER_DIGEST_MAX_BYTES}-byte`);
	expect(output.join("\n")).toContain("shrink or split");
	expect(output.join("\n")).toContain("stays dead_letter");
	expect(output.join("\n")).not.toContain("pending again");
	expect(output.join("\n")).not.toContain("sends it");
	s.close();
});
