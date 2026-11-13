import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { memStore } from "../testing/store.ts";
import { HEALTH_CONFIG as C, measure as measureWith, healthTicker, readHealth } from "./steward-health.ts";
import { askQuestion, QUEUE } from "./questions.ts";
import { parseAsk } from "../ask.ts";
// The format signal reads a prompt hook that grades each reply; this is its pattern, as an operator would configure it.
const formatPattern = /FORMAT CONTRACT[^\n]*Last response (broke:|was clean)/;
// What an adapter tells the health check about its tools: here the fixtures' `t3_thread_read` and a `peek.ts` shell call.
const threadReadKey = (tool: string, input: Record<string, any>) => {
	if (tool.endsWith("t3_thread_read") && typeof input.threadId === "string") return `${input.environmentId ?? "local"}:${input.threadId}`;
	const m = tool === "Bash" ? String(input.command ?? "").match(/\bpeek\.ts\s+([\w-]+)\s+([\w:-]+)/) : null;
	return m ? `${m[1]}:${m[2]}` : undefined;
};
const measure = (lines: Iterable<string>, session: string, now?: number) => measureWith(lines, session, now, { formatPattern, threadReadKey });
// Synthetic ids, built at runtime: the Steward's native session must look like a UUID.
const fakeId = (c: string) => [8, 4, 4, 4, 12].map((n) => c.repeat(n)).join("-");
const session = fakeId("a");
const fixture = readFileSync(new URL("./fixtures/steward-health.jsonl", import.meta.url), "utf8").replaceAll("{{SESSION}}", session).trim().split("\n");
const row = (x: object) => JSON.stringify(x);
const assistant = (tokens: number, content: object[] = [], timestamp = "2026-11-10T13:03:00Z") => row({ type: "assistant", timestamp, message: { usage: { input_tokens: tokens }, content } });
const hook = (i: number, broken = true) => row({ type: "attachment", uuid: `new-${i}`, attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit" }, rendered: `FORMAT CONTRACT: Last response ${broken ? "broke: test" : "was clean"}` });
test("fixture: latest usage snapshot, compaction reset, hook and tool deduplication", async () => {
	const h = await measure(fixture, session);
	expect(h.tokens).toBe(202000); expect(h.peakTokens).toBe(202000);
	expect(h.breaks).toBe(1); expect(h.replies).toBe(2); expect(h.selfReads).toBe(1); expect(h.threadRereads).toBe(1); expect(h.verdict).toBe("WATCH");
});
test("format counts only last N hook replies and never assistant quotes", async () => {
	const h = await measure([...fixture, assistant(100, [{ type: "text", text: "Last response broke: quoted" }]), ...Array.from({ length: C.replies }, (_, i) => hook(i, false))], session);
	expect(h.breaks).toBe(0); expect(h.replies).toBe(C.replies); expect(h.verdict).toBe("OK");
});
test("quoted format text in ordinary attachments never counts as hook evidence", async () => {
	const quoted = Array.from({ length: 4 }, (_, i) => row({ type: "attachment", uuid: `quoted-${i}`, attachment: { type: "file" }, rendered: "FORMAT CONTRACT: Last response broke: quoted" }));
	const h = await measure([...fixture, ...quoted], session);
	expect(h.breaks).toBe(1); expect(h.verdict).toBe("WATCH");
});
test("all signals reset at the latest compaction; unknown is WATCH", async () => {
	const h = await measure([...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" })], session);
	expect(h.tokens).toBeUndefined(); expect(h.breaks).toBe(0); expect(h.selfReads).toBe(0); expect(h.threadRereads).toBe(0); expect(h.verdict).toBe("WATCH");
});
test("verdict cases: size alone never hands off; quality signals do", async () => {
	const small = await measure([...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1, false), assistant(10_000)], session);
	expect(small.verdict).toBe("OK");
	const big = await measure([...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1, false), assistant(C.compactContext + 1)], session);
	expect(big.verdict).toBe("COMPACT"); expect(big.report).toContain("Compaction needed"); expect(big.report).not.toMatch(/hand ?off/i);
	expect((await measure([...fixture, hook(1, false), assistant(C.compactContext)], session)).verdict).toBe("WATCH");
	expect((await measure([...fixture, hook(1, false), assistant(C.context)], session)).verdict).toBe("WATCH");
	const clean = [row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1, false)];
	const slips = await measure([...clean, hook(2), hook(3), hook(4), assistant(C.compactContext + 1)], session);
	expect(slips.verdict).toBe("HAND OFF"); expect(slips.elevated).toContain("format");
	expect((await measure([...clean, hook(2), hook(3), hook(4), assistant(10_000)], session)).verdict).toBe("HAND OFF");
	const repeats = Array.from({ length: 5 }, (_, i) => assistant(10, [{ type: "tool_use", id: `r${i}`, name: "mcp__t3-code__t3_thread_read", input: { threadId: "t-a" } }], `2026-11-10T13:0${i + 3}:00Z`));
	const rr = await measure([...clean, ...repeats, assistant(C.compactContext + 1)], session);
	expect(rr.threadRereads).toBeGreaterThanOrEqual(4); expect(rr.verdict).toBe("HAND OFF");
});
test("compact threshold stays above the watch threshold", () => { expect(C.compactContext).toBe(350_000); expect(C.context).toBeLessThan(C.compactContext); });
test("reread timestamps and environment scope; reads outside window are not repeats", async () => {
	const call = (id: string, environmentId?: string) => ({ type: "tool_use", id, name: "mcp__t3-code__t3_thread_read", input: { threadId: "thread-a", environmentId } });
	const h = await measure([...fixture, assistant(202000, [call("remote", "remote")]), assistant(202000, [call("late")], "2026-11-10T14:00:00Z")], session);
	expect(h.threadRereads).toBe(1);
	const self = await measure([...fixture, assistant(202000, [1, 2].map(i => ({ type: "tool_use", id: `bash${i}`, name: "Bash", input: { command: `tail /sessions/${session}.jsonl` } })))], session);
	expect(self.selfReads).toBe(3); expect(self.verdict).toBe("HAND OFF");
});
test("both reread counters together are one elevated signal", async () => {
	const calls = Array.from({ length: 5 }, (_, i) => assistant(10, [{ type: "tool_use", id: `repeat-${i}`, name: "mcp__t3-code__t3_thread_read", input: { threadId: "fresh-thread" } }, { type: "tool_use", id: `self-${i}`, name: "Read", input: { file_path: `/sessions/${session}.jsonl` } }], `2026-11-10T13:0${i + 3}:00Z`));
	const h = await measure([...fixture, ...calls], session);
	expect(h.threadRereads).toBe(5); expect(h.elevated).toEqual(["rereading"]); expect(h.verdict).toBe("HAND OFF");
});
test("malformed row does not crash or yield false OK", async () => {
	const h = await measure([...fixture, assistant(10), "{partial"], session);
	expect(h.verdict).toBe("WATCH"); expect(h.unknown).toContain("malformed transcript row");
});
test("hourly tick persists and deduplicates across restart, compaction and Not yet", async () => {
	const store = memStore(); let now = Date.now(), calls = 0, active = session;
	const collect = () => measure([...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1), hook(2), hook(3), assistant(10_000)], active, now);
	const ask = async (raw: object) => { calls++; askQuestion(store, parseAsk(raw, `Q-health${calls}`)); };
	try {
		const tick = healthTicker({ store, collect, ask, now: () => now });
		await tick(); await tick(); expect(calls).toBe(1); expect(readHealth(store)?.verdict).toBe("HAND OFF");
		store.items.resolve(QUEUE, "Q-health1");
		now += C.intervalMs;
		await healthTicker({ store, collect, ask, now: () => now })(); expect(calls).toBe(1);
		active = fakeId("b"); now += C.intervalMs;
		await tick(); expect(calls).toBe(2);
	} finally { /* in-memory store: nothing to remove */ }
});
test("a COMPACT verdict is persisted but raises no hand-off question", async () => {
	const store = memStore(); let calls = 0;
	try {
		await healthTicker({ store, collect: () => measure([...fixture, row({ type: "system", subtype: "compact_boundary", timestamp: "new" }), hook(1, false), assistant(C.compactContext + 1)], session), ask: async () => { calls++; } })();
		expect(readHealth(store)?.verdict).toBe("COMPACT"); expect(calls).toBe(0);
	} finally { /* in-memory store: nothing to remove */ }
});
test("failed ask retries; collection failure persists WATCH", async () => {
	const store = memStore(); let calls = 0, now = Date.now();
	try {
		const tick = healthTicker({ store, now: () => now, collect: () => measure([...fixture, hook(1), hook(2), assistant(10_000)], session, now), ask: async () => { calls++; throw Error("offline"); } });
		await expect(tick()).rejects.toThrow("offline"); expect(readHealth(store)?.verdict).toBe("HAND OFF"); now += C.intervalMs;
		await expect(tick()).rejects.toThrow(); expect(calls).toBe(2); now += C.intervalMs;
		await healthTicker({ store, now: () => now, collect: async () => { throw Error("unavailable"); }, ask: async () => {} })(); expect(readHealth(store)?.verdict).toBe("WATCH");
	} finally { /* in-memory store: nothing to remove */ }
});
