import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import type { WakeUsage } from "../store/store-records.ts";
import { flowReport, formatFlow } from "./steward-flow.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const at = (s: string) => Date.parse(s);
const turn = (o: Partial<WakeUsage> & { kind: string; at: string; key: string }): WakeUsage => ({
	session: "s1",
	wakeKey: o.key,
	kind: o.kind,
	startedAt: at(o.at),
	endedAt: at(o.at) + 1000,
	requests: 2,
	inputTokens: 0,
	cacheReadInputTokens: 400_000,
	cacheCreationInputTokens: 0,
	outputTokens: 0,
	compactions: 0,
	...(o.deliveryId ? { deliveryId: o.deliveryId } : {}),
	...(o.contextStart !== undefined ? { contextStart: o.contextStart } : {}),
	...(o.threadReads !== undefined ? { threadReads: o.threadReads, toolCalls: o.threadReads } : {}),
});

type RowSpec = {
	id: string;
	ids: string[];
	when: string;
	status: "delivered" | "cancelled";
	receiver?: string;
	folded?: number;
};
/** Holds the ids at `when`, composes them into one row, and finishes it as delivered or cancels it. */
function row(s: ReturnType<typeof memStore>, o: RowSpec) {
	const lane = o.receiver ? { receiver: o.receiver } : {};
	for (const m of o.ids)
		s.wakes.hold({ deliveryId: m, message: "m", queuedAt: at(o.when), kind: "turn_ended", ...lane });
	const r = s.wakes.compose(
		at(o.when),
		() => ({ deliveryId: o.id, message: "m", folded: o.folded ?? 0, members: o.ids, ...lane }),
		o.receiver ?? null,
	)!;
	if (o.status === "delivered") s.wakes.finish(r.id, "delivered", at(o.when) + 1000);
	else s.wakes.cancel(o.id, at(o.when) + 1000);
}

describe("the flow report", () => {
	test("counts turns by source, held notes and answers, delivered digests and their items, and reads per item", () => {
		const s = memStore();
		s.usage.upsert([
			turn({ kind: "message", at: "2026-11-17T10:00:00Z", key: "m1" }),
			turn({ kind: "message", at: "2026-11-18T09:00:00Z", key: "m2" }),
			turn({ kind: "notice", at: "2026-11-18T09:10:00Z", key: "n1" }),
			turn({
				kind: "digest",
				at: "2026-11-18T09:20:00Z",
				key: "d1",
				deliveryId: "digest:aa",
				threadReads: 2,
				contextStart: 200_000,
			}),
			turn({ kind: "turn_ended", at: "2026-11-18T09:30:00Z", key: "t1", contextStart: 220_000 }),
		]);
		// A digest delivered to the Steward: 5 members, one folded, so 4 items; a note and an answer among them.
		row(s, {
			id: "digest:aa",
			ids: ["note:abc", "answer:item:Q-1", "x", "y", "z"],
			when: "2026-11-18T09:19:00Z",
			status: "delivered",
			folded: 1,
		});
		// Composed but never delivered, and one for the desk: neither is a Steward digest.
		row(s, { id: "digest:bb", ids: ["p", "q"], when: "2026-11-18T09:40:00Z", status: "cancelled" });
		row(s, { id: "digest:cc", ids: ["r", "t"], when: "2026-11-18T09:45:00Z", status: "delivered", receiver: "desk" });
		// A note still held.
		s.wakes.hold({ deliveryId: "note:def", message: "m", queuedAt: at("2026-11-18T10:00:00Z"), kind: "note" });
		const days = flowReport(s, { days: 2, now: NOW });
		expect(days.map((d) => d.day)).toEqual(["2026-11-17", "2026-11-18"]);
		expect(days[0]!.turns).toEqual({ direct: 1, notice: 0, wakes: 0, other: 0 });
		const today = days[1]!;
		expect(today.turns).toEqual({ direct: 1, notice: 1, wakes: 2, other: 0 });
		expect(today.tokens.wakes).toBe(800_000);
		expect(today).toMatchObject({
			notesHeld: 2,
			answersHeld: 1,
			digests: 1,
			digestItems: 4,
			readsPerItem: 0.5,
			contextP50: 200_000,
		});
		expect(formatFlow(days)).toContain("0.50");
	});

	test("a digest delivered the day before still names its items for a turn inside the window", () => {
		const s = memStore();
		row(s, { id: "digest:late", ids: ["a", "b"], when: "2026-11-17T23:59:00Z", status: "delivered" });
		s.usage.upsert([
			turn({ kind: "digest", at: "2026-11-18T00:01:00Z", key: "d", deliveryId: "digest:late", threadReads: 1 }),
		]);
		const [today] = flowReport(s, { days: 1, now: NOW });
		expect(today!.readsPerItem).toBe(0.5);
		expect(today!.digests).toBe(0);
	});

	test("a day with no measured digest has no reads per item", () => {
		const days = flowReport(memStore(), { days: 1, now: NOW });
		expect(days[0]!.readsPerItem).toBeUndefined();
		expect(formatFlow(days)).toContain("2026-11-18");
	});
});
