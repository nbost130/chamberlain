/**
 * D: undelivered message — short completed run, executedModel null, trailing user/agent message with no assistant reply.
 * Fixture shaped like Pilot B on Omar at 23:55 / 04:41 / 12:34 (2026-11-15).
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { runSource } from "./source.ts";
import {
	isUndeliveredRun,
	latestCompletedRun,
	parseUndelivered,
	type RunSnap,
	type TurnSnap,
	UNDELIVERED_DEFAULTS,
	undeliveredFindings,
	undeliveredSource,
	undeliveredText,
} from "./undelivered.ts";

/** Pilot B's 12:34Z run: ~3.7s, no executedModel, user_message then system_notice/checkpoint only. */
const B_RUN: RunSnap = {
	id: "run:thread:mcp%3Alaunch%3Abcdef802:ordinal:13",
	ordinal: 13,
	status: "completed",
	requestedAt: "2026-11-15T12:34:25.274Z",
	startedAt: "2026-11-15T12:34:25.394Z",
	completedAt: "2026-11-15T12:34:28.957Z",
	executedModel: null,
	userMessageId: "message:send:374da1c6",
};

const B_ITEMS_STUCK: TurnSnap[] = [
	{ type: "assistant_message", status: "completed", updatedAt: "2026-11-14T21:49:16.280Z" },
	{ type: "user_message", status: "completed", updatedAt: "2026-11-15T12:34:25.274Z" },
	{ type: "system_notice", status: "completed", updatedAt: "2026-11-15T12:34:28.807Z" },
	{ type: "checkpoint", status: "completed", updatedAt: "2026-11-15T12:34:28.957Z" },
];

const B_ITEMS_AFTER_RESEND: TurnSnap[] = [
	...B_ITEMS_STUCK,
	{ type: "user_message", status: "completed", updatedAt: "2026-11-15T12:37:38.044Z" },
	{ type: "assistant_message", status: "completed", updatedAt: "2026-11-15T12:37:51.727Z" },
];

describe("undelivered config", () => {
	test("defaults: on, every minute, 10 second max duration", () =>
		expect(parseUndelivered(undefined)).toEqual(UNDELIVERED_DEFAULTS));
	test("unknown keys are refused", () => expect(() => parseUndelivered({ foo: 1 })).toThrow("unknown key"));
});

describe("D: isUndeliveredRun (Pilot B short no-model runs)", () => {
	test("the 12:34 stuck shape is undelivered", () => expect(isUndeliveredRun(B_RUN, B_ITEMS_STUCK, 10_000)).toBe(true));
	test("after a real assistant reply it is not", () =>
		expect(isUndeliveredRun(B_RUN, B_ITEMS_AFTER_RESEND, 10_000)).toBe(false));
	test("a short run that did execute a model is not", () =>
		expect(isUndeliveredRun({ ...B_RUN, executedModel: "claude-opus-5-5" }, B_ITEMS_STUCK, 10_000)).toBe(false));
	test("a long run without a model is not (threshold)", () =>
		expect(
			isUndeliveredRun(
				{ ...B_RUN, startedAt: "2026-11-15T12:34:25.000Z", completedAt: "2026-11-15T12:35:00.000Z" },
				B_ITEMS_STUCK,
				10_000,
			),
		).toBe(false));
	test("latestCompletedRun picks the highest ordinal", () => {
		const runs: RunSnap[] = [
			{ id: "a", ordinal: 12, status: "completed", completedAt: "2026-11-15T04:41:12Z" },
			B_RUN,
			{ id: "c", ordinal: 11, status: "completed", completedAt: "2026-11-15T23:56:00Z" },
		];
		expect(latestCompletedRun(runs)?.id).toBe(B_RUN.id);
	});
});

describe("D: through the item system", () => {
	test("a stuck B-shaped thread notifies once with the resend text", async () => {
		const store = memStore();
		const hits = [
			{
				server: "omar",
				threadId: "mcp:launch:bcdef802",
				title: "Pilot B",
				runId: B_RUN.id!,
			},
		];
		const first = await runSource(
			store,
			undeliveredSource({
				cfg: UNDELIVERED_DEFAULTS,
				select: async () => hits,
			}),
			{ now: Date.parse("2026-11-15T12:35:00Z") },
		);
		expect(first.notified).toHaveLength(1);
		expect(String(first.notified[0]!.payload.text)).toBe(
			undeliveredText("omar", "mcp:launch:bcdef802", "Pilot B", B_RUN.id!),
		);
		expect(String(first.notified[0]!.payload.text)).toContain("message delivered but the model never ran; resend");
		const again = await runSource(store, undeliveredSource({ cfg: UNDELIVERED_DEFAULTS, select: async () => hits }), {
			now: Date.parse("2026-11-15T12:36:00Z"),
		});
		expect(again.notified).toEqual([]);
		expect(undeliveredFindings(hits)[0]!.dedupKey).toContain(B_RUN.id!);
	});
});
