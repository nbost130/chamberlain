/** F13–F15: tombstone, missing attempt, resolve-while-pending. */
import { describe, expect, test } from "bun:test";
import { min, T0, triageRig } from "../testing/alert-triage-fixtures.ts";
import { runTriage } from "./alert-triage-cli.ts";
import { ALERT_TRIAGE } from "./alert-triage-config.ts";

describe("F recovery edge cases", () => {
	test("F13 tombstone only", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [], ackMinutes: 15 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.settle(T0);
		r.append({ family: "tomb" });
		r.pass(T0);
		const id = r.stewardRows()[0]!.deliveryId;
		r.store.wakes.finish(r.stewardRows()[0]!.id, "delivered", T0);
		r.store.wakes.prune(T0 + 1);
		const found = r.store.wakes.find(id);
		if (found) {
			r.store.wakes.cancel(id, T0);
			r.store.wakes.prune(T0 + 40 * 24 * 3600_000);
		}
		r.pass(min(1));
		expect(r.stewardRows().length).toBeGreaterThanOrEqual(1);
	});

	test("F14 attempt missing", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ family: "miss" });
		r.pass(T0);
		const n = r.stewardRows().length;
		const key = r.store.items.list({ source: ALERT_TRIAGE, kind: "obligation" })[0]!.dedupKey;
		r.store.items.patch(ALERT_TRIAGE, key, {
			attempts: ["triage:deadbeefdeadbeefdead:0"],
			state: "sent",
			slot: true,
		});
		r.pass(min(1));
		expect(r.obligations()[0]!.reason).toBe("missing");
		expect(r.stewardRows().length).toBe(n + 1);
	});

	test("F15 resolve while pending", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.settle(T0);
		r.append({ family: "pend" });
		r.pass(T0);
		const occ = r.obligations()[0]!.occ;
		runTriage(r.store, ["resolve", occ]);
		const n = r.stewardRows().length;
		r.store.wakes.finish(r.stewardRows()[0]!.id, "delivered", min(1));
		r.pass(min(30));
		expect(r.stewardRows()).toHaveLength(n);
	});
});
