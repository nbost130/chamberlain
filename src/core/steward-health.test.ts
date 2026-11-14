import { expect, test } from "bun:test";
import {
	assistant,
	degraded,
	fakeId,
	fixture,
	handingOff,
	hook,
	INSTRUCTION,
	measure,
	queued,
	row,
	session,
} from "../testing/core-steward-health-fixtures.ts";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { readHealth } from "./steward-health.ts";
import { HEALTH_CONFIG as C } from "./steward-health-config.ts";

test("fixture: latest usage snapshot, compaction reset, hook and tool deduplication", async () => {
	const h = await measure(fixture, session);
	expect(h.tokens).toBe(202000);
	expect(h.peakTokens).toBe(202000);
	expect(h.breaks).toBe(1);
	expect(h.replies).toBe(2);
	expect(h.selfReads).toBe(1);
	expect(h.threadRereads).toBe(1);
	expect(h.verdict).toBe("WATCH");
});

test("format counts only last N hook replies and never assistant quotes", async () => {
	const h = await measure(
		[
			...fixture,
			assistant(100, [{ type: "text", text: "Last response broke: quoted" }]),
			...Array.from({ length: C.replies }, (_, i) => hook(i, false)),
		],
		session,
	);
	expect(h.breaks).toBe(0);
	expect(h.replies).toBe(C.replies);
	expect(h.verdict).toBe("OK");
});

test("quoted format text in ordinary attachments never counts as hook evidence", async () => {
	const quoted = Array.from({ length: 4 }, (_, i) =>
		row({
			type: "attachment",
			uuid: `quoted-${i}`,
			attachment: { type: "file" },
			rendered: "FORMAT CONTRACT: Last response broke: quoted",
		}),
	);
	const h = await measure([...fixture, ...quoted], session);
	expect(h.breaks).toBe(1);
	expect(h.verdict).toBe("WATCH");
});

test("all signals reset at the latest compaction; unknown is WATCH", async () => {
	const h = await measure(
		[...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" })],
		session,
	);
	expect(h.tokens).toBeUndefined();
	expect(h.breaks).toBe(0);
	expect(h.selfReads).toBe(0);
	expect(h.threadRereads).toBe(0);
	expect(h.verdict).toBe("WATCH");
});

test("verdict cases: size alone never hands off; quality signals do", async () => {
	const small = await measure(
		[
			...fixture,
			row({ type: "system", subtype: "compact_boundary", timestamp: "new" }),
			hook(1, false),
			assistant(10_000),
		],
		session,
	);
	expect(small.verdict).toBe("OK");
	const big = await measure(
		[
			...fixture,
			row({ type: "system", subtype: "compact_boundary", timestamp: "new" }),
			hook(1, false),
			assistant(C.compactContext + 1),
		],
		session,
	);
	expect(big.verdict).toBe("COMPACT");
	expect(big.report).toContain("Compaction needed");
	expect(big.report).not.toMatch(/hand ?off/i);
	expect((await measure([...fixture, hook(1, false), assistant(C.compactContext)], session)).verdict).toBe("WATCH");
	expect((await measure([...fixture, hook(1, false), assistant(C.context)], session)).verdict).toBe("WATCH");
	const clean = [row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1, false)];
	const slips = await measure([...clean, hook(2), hook(3), hook(4), assistant(C.compactContext + 1)], session);
	expect(slips.verdict).toBe("HAND OFF");
	expect(slips.elevated).toContain("format");
	expect((await measure([...clean, hook(2), hook(3), hook(4), assistant(10_000)], session)).verdict).toBe("HAND OFF");
	const repeats = Array.from({ length: 5 }, (_, i) =>
		assistant(
			10,
			[{ type: "tool_use", id: `r${i}`, name: "mcp__t3-code__t3_thread_read", input: { threadId: "t-a" } }],
			`2026-11-10T13:0${i + 3}:00Z`,
		),
	);
	const rr = await measure([...clean, ...repeats, assistant(C.compactContext + 1)], session);
	expect(rr.threadRereads).toBeGreaterThanOrEqual(4);
	expect(rr.verdict).toBe("HAND OFF");
});

test("compact threshold stays above the watch threshold", () => {
	expect(C.compactContext).toBe(350_000);
	expect(C.context).toBeLessThan(C.compactContext);
});

test("reread timestamps and environment scope; reads outside window are not repeats", async () => {
	const call = (id: string, environmentId?: string) => ({
		type: "tool_use",
		id,
		name: "mcp__t3-code__t3_thread_read",
		input: { threadId: "thread-a", environmentId },
	});
	const h = await measure(
		[
			...fixture,
			assistant(202000, [call("remote", "remote")]),
			assistant(202000, [call("late")], "2026-11-10T14:00:00Z"),
		],
		session,
	);
	expect(h.threadRereads).toBe(1);
	const self = await measure(
		[
			...fixture,
			assistant(
				202000,
				[1, 2].map((i) => ({
					type: "tool_use",
					id: `bash${i}`,
					name: "Bash",
					input: { command: `tail /sessions/${session}.jsonl` },
				})),
			),
		],
		session,
	);
	expect(self.selfReads).toBe(3);
	expect(self.verdict).toBe("HAND OFF");
});

test("both reread counters together are one elevated signal", async () => {
	const calls = Array.from({ length: 5 }, (_, i) =>
		assistant(
			10,
			[
				{
					type: "tool_use",
					id: `repeat-${i}`,
					name: "mcp__t3-code__t3_thread_read",
					input: { threadId: "fresh-thread" },
				},
				{ type: "tool_use", id: `self-${i}`, name: "Read", input: { file_path: `/sessions/${session}.jsonl` } },
			],
			`2026-11-10T13:0${i + 3}:00Z`,
		),
	);
	const h = await measure([...fixture, ...calls], session);
	expect(h.threadRereads).toBe(5);
	expect(h.elevated).toEqual(["rereading"]);
	expect(h.verdict).toBe("HAND OFF");
});

test("malformed row does not crash or yield false OK", async () => {
	const h = await measure([...fixture, assistant(10), "{partial"], session);
	expect(h.verdict).toBe("WATCH");
	expect(h.unknown).toContain("malformed transcript row");
});

test("usage counts are summed and the peak kept; a count that is not a non-negative number reads as unavailable but is still sampled", async () => {
	const usage = (u: object, timestamp: string) =>
		row({ type: "assistant", timestamp, message: { usage: u, content: [] } });
	const good = await measure(
		[usage({ input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }, "2026-11-10T13:00:00Z")],
		session,
	);
	expect(good).toMatchObject({ tokens: 123, peakTokens: 123, usageAt: "2026-11-10T13:00:00Z" });
	const bad = await measure(
		[
			usage({ input_tokens: 100, cache_read_input_tokens: 20 }, "2026-11-10T13:00:00Z"),
			usage({ input_tokens: -1 }, "2026-11-10T13:05:00Z"),
		],
		session,
	);
	expect(bad.tokens).toBeUndefined();
	expect(bad.peakTokens).toBe(120);
	expect(bad.usageAt).toBe("2026-11-10T13:05:00Z");
	expect(bad.unknown).toContain("context usage unavailable");
	const text = await measure([usage({ input_tokens: "5" }, "2026-11-10T13:00:00Z")], session);
	expect(text.tokens).toBeUndefined();
	expect(text.peakTokens).toBeUndefined();
});

test("sidechain rows are ignored; a shell read of the session file is a self read and a mention is not", async () => {
	const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
	const h = await measure(
		[
			row({ isSidechain: true, type: "assistant", timestamp: "t", message: { usage: { input_tokens: 999 } } }),
			assistant(50, [
				bash("b1", `cat /x/${session}.jsonl`),
				bash("b2", `echo ${session}.jsonl`),
				bash("b3", "cat /x/other.jsonl"),
				{ type: "tool_use", id: "r1", name: "Read", input: { file_path: `/x/${session}.jsonl` } },
				{ type: "tool_use", id: "r2", name: "Read", input: {} },
				{ type: "text", text: "no id" },
				{ type: "tool_use", name: "Read", input: { file_path: `/x/${session}.jsonl` } },
			]),
		],
		session,
	);
	expect(h.tokens).toBe(50);
	expect(h.selfReads).toBe(2);
});

test("a thread read with no readable timestamp is reported unknown and never counted as a repeat", async () => {
	const read = (id: string) => ({ type: "tool_use", id, name: "mcp__x__t3_thread_read", input: { threadId: "t1" } });
	const h = await measure(
		[
			row({ type: "assistant", message: { usage: { input_tokens: 1 }, content: [read("a"), read("b")] } }),
			assistant(1, [read("c")], "2026-11-10T13:00:00Z"),
			assistant(1, [read("d")], "2026-11-10T13:01:00Z"),
		],
		session,
	);
	expect(h.unknown).toContain("read timestamp missing");
	expect(h.threadRereads).toBe(1);
});

test("a HAND OFF verdict queues the hand-off wake itself, once per session, across restart and compaction", async () => {
	const store = memStore();
	let now = Date.now(),
		active = session;
	const collect = degraded(
		() => active,
		() => now,
	);
	const tick = handingOff(store, collect, () => now);
	await tick();
	await tick();
	expect(readHealth(store)?.verdict).toBe("HAND OFF");
	expect(queued(store)).toHaveLength(1);
	const w = queued(store)[0]!;
	expect(w.deliveryId).toBe(`steward-handoff:${session}`);
	expect(w.message).toContain(INSTRUCTION);
	expect(w.message).toContain("Steward health: HAND OFF");
	expect(w.message).toContain("do not ask first");
	// Nothing was put to the operator: the question queue stays empty.
	expect(store.items.list({ source: "queue" })).toHaveLength(0);
	now += C.intervalMs;
	await handingOff(store, collect, () => now)(); // a restarted daemon, same session
	expect(queued(store)).toHaveLength(1);
	active = fakeId("b");
	now += C.intervalMs;
	await tick();
	expect(queued(store).map((r) => r.deliveryId)).toEqual([
		`steward-handoff:${session}`,
		`steward-handoff:${fakeId("b")}`,
	]);
});

test("a hand-off wake already delivered is not queued again by a later hourly check", async () => {
	const store = memStore();
	let now = Date.now();
	const tick = handingOff(
		store,
		degraded(
			() => session,
			() => now,
		),
		() => now,
	);
	await tick();
	const { drain } = testRelay(store, { ready: () => true, send: async () => ({ ok: true, status: 202 }) });
	await drain();
	expect(store.wakes.find(`steward-handoff:${session}`)?.status).toBe("delivered");
	now += C.intervalMs;
	await tick();
	// The id is known for good: no second row, nothing pending, the first still delivered.
	expect(store.wakes.rows().filter((r) => r.status === "pending")).toHaveLength(0);
	expect(store.wakes.find(`steward-handoff:${session}`)?.status).toBe("delivered");
});
