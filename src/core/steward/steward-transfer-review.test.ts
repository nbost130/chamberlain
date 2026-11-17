/** Review round on #100: replay envelopes, composed replays, pruned roots. (False receipts: src/adapters/t3/receipts.webhook-only.test.ts.) */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { commitSwitch } from "./steward-commit.ts";
import { isDischarged } from "./steward-discharge.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { composeTransferBatch, transferPass } from "./steward-transfer.ts";

const { confWorld, memStoreSeeded, writeSwitchRefs, deliverAndLedger } = useStewardSwitchFixtures();

function switchTo(store: ReturnType<typeof memStoreSeeded>, conf: string, thread: string, now: number) {
	const p = prepareSwitch(store, conf, { toThread: thread, live: true, now });
	if (!p.ok) throw new Error(p.error);
	writeSwitchRefs(conf, p.id);
	expect(commitSwitch(store, conf, { id: p.id, live: true, now }).ok).toBe(true);
}
const handled = (s: ReturnType<typeof memStoreSeeded>, outboxId: number, at: number) =>
	s.steward.insertReceipt({ outboxId, kind: "t3-run", runId: `run-${outboxId}`, thread: "g1", recordedAt: at });

describe("replays of wakes found handled after the switch", () => {
	test("a replay envelope delivered to g2 whose root is found handled is not replayed again to g3, and g2's transfer can close", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 200_000);
		transferPass(s, 200_000);
		const env = s.wakes.compose(200_000, (held) => composeTransferBatch(held, 200_000)!, null)!;
		s.wakes.finish(env.id, "delivered", 200_001);
		s.steward.insertLedger({ outboxId: env.id, gen: 2, origin: "live" });
		handled(s, id, 100_000);
		expect(isDischarged(s, env.id)).toBe(true);
		switchTo(s, w.conf, "g3", 400_000);
		expect(transferPass(s, 400_000).held).toBe(0);
		expect(s.steward.transfer(2)!.closedAt).toBeDefined();
	});

	test("a composed replay not yet attempted is cancelled once its root is found handled; one already attempted is left", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		const a = deliverAndLedger(s, { deliveryId: "A", message: "payload", at: 1_000, gen: 1 });
		switchTo(s, w.conf, "g2", 200_000);
		transferPass(s, 200_000);
		const row = s.wakes.compose(200_000, (held) => composeTransferBatch(held, 200_000)!, null)!;
		handled(s, a, 100_000);
		transferPass(s, 300_000);
		expect(s.wakes.byId(row.id)!.status).toBe("cancelled");
		const b = deliverAndLedger(s, { deliveryId: "B", message: "payload", at: 1_000, gen: 2 });
		switchTo(s, w.conf, "g3", 400_000);
		transferPass(s, 400_000);
		const started = s.wakes.compose(400_000, (held) => composeTransferBatch(held, 400_000)!, null)!;
		s.wakes.beginAttempt(started.id, 400_001);
		handled(s, b, 300_000);
		transferPass(s, 500_000);
		expect(s.wakes.byId(started.id)!.status).toBe("pending");
	});

	test("a root that retention already deleted counts as handled", () => {
		const w = confWorld();
		const s = memStoreSeeded(w.conf, 1_000);
		expect(isDischarged(s, 987_654)).toBe(true);
		const id = deliverAndLedger(s, { deliveryId: "R", message: "payload", at: 1_000, gen: 1 });
		expect(isDischarged(s, id)).toBe(false);
	});
});
