/** What a digest says about each held item: freshness of turn-end reports against T3's state, which items fold, and tool counts. */
import { describe, expect, test } from "bun:test";
import { fullSweepHead } from "../messages.ts";
import { segmentTranscript } from "../steward/steward-segments.ts";
import { composeWake, type HeldItem, reportRunId, type ThreadNews } from "./hold.ts";

const T0 = Date.parse("2026-11-18T01:30:00Z");
const RUN = "run:thread:T1:ordinal:8";
const te = (id: string, thread: string, queuedAt = T0): HeldItem => ({
	deliveryId: id,
	message: `report ${id}`,
	queuedAt,
	kind: "turn_ended",
	thread,
});
/** Two reports so composeWake writes item headers (a lone item goes as itself); returns item a's header. */
const header = (news: ThreadNews | undefined, id = `T1:ended:${RUN}:1794944776113`) => {
	const c = composeWake([te(id, "T1"), te("T2:ended:run:thread:T2:ordinal:1:1794944776114", "T2")], T0, {
		news: (t) => (t === "T1" ? news : undefined),
	});
	return c.message.split("\n").find((l) => l.includes(`deliveryId: ${id} `))!;
};
const live = (o: Partial<ThreadNews> = {}): ThreadNews => ({
	connected: true,
	latestRunId: RUN,
	status: "completed",
	...o,
});

describe("the run a report is about", () => {
	test("the whole run id, colons and all; none for a timestamp-only report", () => {
		expect(reportRunId(`mcp:launch:abc:ended:${RUN}:1794944776113`)).toBe(RUN);
		expect(reportRunId("t1:ended:r20")).toBe("r20");
		expect(reportRunId("t1:ended:1794944776113")).toBeUndefined();
		expect(reportRunId("t1:failed:x")).toBeUndefined();
	});
});

describe("what a digest notes about a held turn-end report", () => {
	test("only what was observed: a newer run, working again, settled or archived, each stamped", () => {
		expect(header(live({ latestRunId: "run:thread:T1:ordinal:9" }))).toContain(
			"seen at 01:30 UTC: a newer run of its thread has started",
		);
		expect(header(live({ status: "running" }))).toContain("seen at 01:30 UTC: its thread is working again");
		expect(header(live({ settled: true }))).toContain("its thread is settled");
		expect(header(live({ archived: true }))).toContain("its thread is archived");
	});
	test("never a claim that the report is current: an untouched thread, an unknown one, a missing run id get no note", () => {
		for (const h of [
			header(live()),
			header(undefined),
			header(live({ latestRunId: null })),
			header(live(), "T1:ended:1794944776113"),
		])
			expect(h).not.toMatch(/seen at|newest|current/);
	});
	test("no view at all, or another kind: no note", () => {
		const plain = composeWake([te("a", "T1"), te("b", "T2")], T0);
		expect(plain.message).not.toContain("seen at");
		const note: HeldItem = { deliveryId: "n", message: "note", queuedAt: T0, kind: "note", thread: "T1" };
		const c = composeWake([note, te(`T1:ended:${RUN}:1794944776113`, "T1")], T0, {
			news: () => live({ status: "running" }),
		});
		expect(c.message.match(/seen at/g)).toHaveLength(1);
	});
});

describe("which items fold", () => {
	test("reports about different runs of one thread never fold, though run ids share a prefix up to their first colon", () => {
		const a = te("mcp:x:ended:run:thread:mcp%3Ax:ordinal:1:1794944776113", "mcp:x");
		const b = te("mcp:x:ended:run:thread:mcp%3Ax:ordinal:2:1794944776200", "mcp:x", T0 + 1);
		const c = composeWake([a, b], T0);
		expect(c.folded).toBe(0);
		expect(c.message).toContain("report mcp:x:ended:run:thread:mcp%3Ax:ordinal:1");
		expect(c.message).toContain("report mcp:x:ended:run:thread:mcp%3Ax:ordinal:2");
	});
	test("timestamp-only reports of one thread still fold to the latest", () => {
		const c = composeWake([te("t:ended:1794944776113", "t"), te("t:ended:1794944776200", "t", T0 + 1)], T0);
		expect(c.folded).toBe(1);
	});
	test("sweeps never fold: a full sweep, the findings sweep and the idle-thread list each carry what was new when made", () => {
		const full = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: `${fullSweepHead()}\nrun it`,
			queuedAt: at,
			kind: "sweep",
		});
		const findings = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: "[chamberlain] sweep: the routine checks found the items below.",
			queuedAt: at,
			kind: "sweep",
		});
		const idle = (id: string, at: number): HeldItem => ({
			deliveryId: id,
			message: "[chamberlain] idle threads: 2 top-level threads",
			queuedAt: at,
			kind: "sweep",
		});
		const c = composeWake(
			[full("f1", 1), full("f2", 2), findings("s1", 3), findings("s2", 4), idle("i1", 5), idle("i2", 6)],
			10,
		);
		expect(c.folded).toBe(0);
		expect(c.kept).toEqual(["f1", "f2", "s1", "s2", "i1", "i2"]);
	});
});

describe("tool calls per Steward turn", () => {
	const user = JSON.stringify({
		type: "user",
		uuid: "u1",
		timestamp: "2026-11-18T01:00:00Z",
		message: { role: "user", content: "check on the builders" },
	});
	const asst = (id: string, parent: string, content: unknown[]) =>
		JSON.stringify({
			type: "assistant",
			uuid: `a-${id}`,
			parentUuid: parent,
			timestamp: "2026-11-18T01:00:05Z",
			message: {
				id,
				model: "claude-opus-5-5",
				usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 },
				content,
			},
		});
	const bash = (id: string, command?: string) => ({
		type: "tool_use",
		id,
		name: "Bash",
		...(command ? { input: { command } } : {}),
	});
	test("counts each tool call once, and only what a command segment runs as a thread read", async () => {
		const rows = [
			user,
			asst("m1", "u1", [{ type: "tool_use", id: "t1", name: "mcp__t3-code__t3_thread_read", input: {} }]),
			asst("m2", "a-m1", [bash("t2", "cd ~/app; timeout 25 bun src/adapters/t3/peek.ts mac abc")]),
			asst("m2", "a-m2", [bash("t2")]),
			asst("m3", "a-m2", [bash("t3", "echo chamberlain peek later; echo peek")]),
			asst("m4", "a-m3", [bash("t4", "chamberlain debug t3x read mac abc")]),
			asst("m5", "a-m4", [bash("t5", "gh-axi pr view 7 | grep peek.ts")]),
			asst("m6", "a-m5", [bash("t6", "echo 'example; chamberlain debug peek mac abc; done'")]),
			asst("m7", "a-m6", [bash("t7", "/usr/local/bin/chamberlain debug peek mac abc")]),
		];
		const [seg] = await segmentTranscript(rows, "s1");
		expect(seg).toMatchObject({ kind: "message", requests: 7, toolCalls: 7, threadReads: 4 });
	});
});

describe("the idle-thread list's header", () => {
	test("classifies as an idle-parents wake, not a direct message", async () => {
		const { classifyPrompt } = await import("../steward/steward-segments.ts");
		expect(classifyPrompt("[chamberlain] idle threads: 2 top-level threads finished and went quiet")?.kind).toBe(
			"idle-parents",
		);
	});
});
