import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import type { WakeUsage } from "../store/store-records.ts";
import { flowReport, formatFlow } from "./steward-flow.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const turn = (o: Partial<WakeUsage> & { kind: string; at: string; key: string }): WakeUsage => ({
	session: "s1",
	wakeKey: o.key,
	kind: o.kind,
	startedAt: Date.parse(o.at),
	endedAt: Date.parse(o.at) + 1000,
	requests: o.requests ?? 2,
	inputTokens: 0,
	cacheReadInputTokens: o.cacheReadInputTokens ?? 400_000,
	cacheCreationInputTokens: 0,
	outputTokens: 0,
	compactions: 0,
	...(o.deliveryId ? { deliveryId: o.deliveryId } : {}),
	...(o.contextStart !== undefined ? { contextStart: o.contextStart } : {}),
	...(o.threadReads !== undefined ? { threadReads: o.threadReads, toolCalls: o.threadReads } : {}),
});

describe("the flow report", () => {
	test("counts turns by source, held notes and answers, digests and their items, reports given up, and reads per digest item", () => {
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
				threadReads: 3,
				contextStart: 200_000,
			}),
			turn({ kind: "turn_ended", at: "2026-11-18T09:30:00Z", key: "t1", contextStart: 220_000 }),
		]);
		const ev = (t: string, event: string, data: Record<string, unknown>) => s.events.append({ t, event, ...data });
		ev("2026-11-18T09:00:00.000Z", "deliver-held", { deliveryId: "note:abc" });
		ev("2026-11-18T09:01:00.000Z", "deliver-held", { deliveryId: "answer:item:Q-1" });
		ev("2026-11-18T09:02:00.000Z", "deliver-held", { deliveryId: "t9:ended:run:1" });
		ev("2026-11-18T09:19:00.000Z", "composed", {
			deliveryId: "digest:aa",
			members: ["note:abc", "answer:item:Q-1", "x", "y", "z", "w"],
		});
		ev("2026-11-18T09:19:30.000Z", "composed", { deliveryId: "solo", members: ["solo"] });
		ev("2026-11-18T09:25:00.000Z", "held-given-up", { members: ["t7:ended:1", "t8:ended:1"] });
		const days = flowReport(s, { days: 2, now: NOW });
		expect(days.map((d) => d.day)).toEqual(["2026-11-17", "2026-11-18"]);
		expect(days[0]!.turns).toEqual({ direct: 1, notice: 0, wakes: 0, other: 0 });
		const today = days[1]!;
		expect(today.turns).toEqual({ direct: 1, notice: 1, wakes: 2, other: 0 });
		expect(today.tokens.wakes).toBe(800_000);
		expect(today).toMatchObject({
			notesHeld: 1,
			answersHeld: 1,
			digests: 1,
			digestItems: 6,
			givenUp: 2,
			readsPerItem: 0.5,
			contextP50: 200_000,
		});
		const text = formatFlow(days);
		expect(text).toContain("2026-11-18");
		expect(text).toContain("0.50");
	});

	test("a day with no measured digest has no reads per item", () => {
		const days = flowReport(memStore(), { days: 1, now: NOW });
		expect(days[0]!.readsPerItem).toBeUndefined();
		expect(formatFlow(days)).toContain("2026-11-18");
	});
});
