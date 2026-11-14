import { describe, expect, test } from "bun:test";
import { idleKey, principalWroteWithin, stewardInstruction, type TurnItem } from "../../core/decide";
import { HISTORY_PAGES_MAX, historyGet, readInstruction, readWhenConnected } from "./history";

const noise = (n: number): TurnItem[] =>
	Array.from({ length: n }, (_, i) => ({ type: "assistant_message", id: `a${i}`, text: "working" }));
const steward: TurnItem = {
	type: "user_message",
	id: "s1",
	text: "Steward: do it",
	createdBy: "agent",
	creationSource: "mcp",
};
const row = (item: TurnItem, extra: object = { visibility: "local" }) => ({ ...extra, item });
const page = (items: TurnItem[], nextCursor: string | null = null) => ({
	items: items.map((i) => row(i)),
	nextCursor,
	hasMoreHistory: nextCursor !== null,
});
const bounded = (turnItems: TurnItem[], historyCursor: string | null = "c1") => ({
	projection: { turnItems },
	historyCursor,
	hasMoreHistory: historyCursor !== null,
});
/** A fake T3: the snapshot, then pages by cursor. Records each path asked for. */
function t3(snapshot: unknown, pages: Record<string, unknown> = {}) {
	const asked: string[] = [];
	const get = async (path: string) => {
		asked.push(path);
		if (path.endsWith("/bounded")) return snapshot;
		const cursor = new URL(path, "http://x").searchParams.get("cursor") as string;
		if (!(cursor in pages)) throw Error(`HTTP 500 for ${cursor}`);
		return pages[cursor];
	};
	return { get, asked };
}

describe("readInstruction", () => {
	test("finds a Steward instruction outside the window", async () => {
		// Before this fix the daemon saw only these 75 items, so it logged skip-turn-ended.
		expect(stewardInstruction(noise(75))).toBeUndefined();
		const { get } = t3(bounded(noise(75)), { c1: page(noise(29), "c2"), c2: page([steward, ...noise(4)]) });
		const read = await readInstruction("t", get);
		expect(read.state).toBe("complete");
		expect(stewardInstruction(read.items)).toBe("s1");
	});
	test("keeps thread order, so the newest instruction still wins", async () => {
		const older = { ...steward, id: "s0" };
		const newer: TurnItem = {
			type: "user_message",
			id: "n1",
			text: "take this over",
			createdBy: "user",
			creationSource: "web",
		};
		const { get } = t3(bounded(noise(75)), { c1: page([older, newer]) });
		expect(stewardInstruction((await readInstruction("t", get)).items)).toBeUndefined();
	});
	test("an idle wake's key and the operator's presence both survive a long turn", async () => {
		const now = Date.parse("2026-11-07T18:00:00Z");
		const operator: TurnItem = {
			type: "user_message",
			id: "n1",
			text: "go",
			createdBy: "user",
			creationSource: "web",
			updatedAt: "2026-11-07T17:50:00Z",
		};
		expect(principalWroteWithin(noise(75), now, 3_600_000)).toBe(false);
		const { get } = t3(bounded(noise(75)), { c1: page([operator]) });
		const { items } = await readInstruction("t", get);
		expect(principalWroteWithin(items, now, 3_600_000)).toBe(true);
		expect(idleKey(items, now + 31 * 60_000)).toBe("idle:n1");
	});
	test("a machine delivery is not an instruction, so paging goes past it", async () => {
		const server: TurnItem = {
			type: "user_message",
			id: "m1",
			text: "Update on PR",
			createdBy: "agent",
			creationSource: "server",
		};
		const { get, asked } = t3(bounded([server, ...noise(3)]), { c1: page([steward]) });
		expect(stewardInstruction((await readInstruction("t", get)).items)).toBe("s1");
		expect(asked).toHaveLength(2);
	});
	test("reads no pages when the window already holds the instruction", async () => {
		const { get, asked } = t3(bounded([steward, ...noise(3)]));
		expect((await readInstruction("t", get)).state).toBe("complete");
		expect(asked).toHaveLength(1);
	});
	test("stops paging at the page that holds it", async () => {
		const { get, asked } = t3(bounded(noise(2)), { c1: page([steward], "c2") });
		await readInstruction("t", get);
		expect(asked).toHaveLength(2);
	});
	test("a thread with no instruction at all is complete, not truncated", async () => {
		const { get } = t3(bounded(noise(75)), { c1: page(noise(3)) });
		const read = await readInstruction("t", get);
		expect(read.state).toBe("complete");
		expect(stewardInstruction(read.items)).toBeUndefined();
	});
	test("a parent's rows in a fork are not this thread's instruction", async () => {
		const inherited = {
			items: [row(steward, { visibility: "inherited", sourceThreadId: "parent" })],
			nextCursor: null,
			hasMoreHistory: false,
		};
		const { get } = t3(bounded(noise(2)), { c1: inherited });
		expect(stewardInstruction((await readInstruction("t", get)).items)).toBeUndefined();
	});
	test("escapes the thread id and cursor and asks for the conversation view", async () => {
		const { get, asked } = t3(bounded(noise(1), "a+b/c"), { "a+b/c": page([steward]) });
		await readInstruction("mcp:x y", get);
		expect(asked[0]).toBe("/api/orchestration/threads/mcp%3Ax%20y/bounded");
		expect(asked[1]).toBe("/api/orchestration/threads/mcp%3Ax%20y/history?cursor=a%2Bb%2Fc&view=conversation");
	});
	test("stops at the page cap and says so", async () => {
		const endless = new Proxy({}, { has: () => true, get: () => page(noise(1), "next") });
		const { get, asked } = t3(bounded(noise(1)), endless as Record<string, unknown>);
		const read = await readInstruction("t", get);
		expect(read.state).toBe("truncated");
		expect(asked).toHaveLength(HISTORY_PAGES_MAX + 1);
	});
	test("more history with no cursor is truncated, not complete", async () => {
		const { get } = t3({ projection: { turnItems: noise(1) }, historyCursor: null, hasMoreHistory: true });
		expect((await readInstruction("t", get)).state).toBe("truncated");
	});
	test("a failed read is failed, on the snapshot or on any page", async () => {
		const snapshotDown = await readInstruction("t", async () => {
			throw Error("HTTP 503");
		});
		expect(snapshotDown).toEqual({ items: [], state: "failed", error: "Error: HTTP 503", byMachine: false });
		const { get } = t3(bounded(noise(2)), {});
		const pageDown = await readInstruction("t", get);
		expect(pageDown.state).toBe("failed");
		expect(pageDown.items).toEqual([]);
	});
	test("a token that can't be read is a failed read, not a throw", async () => {
		const unreadable = await readInstruction(
			"t",
			historyGet("http://127.0.0.1:1", () => {
				throw Error("token file is not private");
			}),
		);
		expect(unreadable).toEqual({
			items: [],
			state: "failed",
			error: "Error: token file is not private",
			byMachine: false,
		});
		expect(
			(
				await readInstruction(
					"t",
					historyGet("http://127.0.0.1:1", () => undefined),
				)
			).error,
		).toBe("Error: no token");
	});
	test("a reply of the wrong shape is failed, not an empty thread", async () => {
		expect((await readInstruction("t", async () => ({}))).state).toBe("failed");
		const { get } = t3(bounded(noise(1)), { c1: { nextCursor: null } });
		expect((await readInstruction("t", get)).state).toBe("failed");
	});
});

describe("who started the turn that last ended", () => {
	const run = (ordinal: number, status: string) => ({ id: `r${ordinal}`, ordinal, status });
	const start: TurnItem = { ...steward, runId: "r1" };
	const note = (runId: string): TurnItem => ({ type: "notification", id: `n${runId}`, runId });
	const after = (runId: string): TurnItem => ({ type: "assistant_message", id: `a${runId}`, runId });
	const snapshot = (runs: object[], turnItems: TurnItem[], historyCursor: string | null = null) => ({
		projection: { turnItems, runs },
		historyCursor,
		hasMoreHistory: historyCursor !== null,
	});
	const read = (runs: object[], items: TurnItem[]) => readInstruction("t", async () => snapshot(runs, items));
	test("a run that starts with a notification is a machine's", async () => {
		expect(
			(await read([run(1, "completed"), run(2, "completed")], [start, after("r1"), note("r2"), after("r2")])).byMachine,
		).toBe(true);
	});
	test("so is one started by a machine delivery, such as a card answer", async () => {
		const delivery: TurnItem = {
			type: "user_message",
			id: "m1",
			runId: "r2",
			text: "result",
			createdBy: "agent",
			creationSource: "server",
		};
		expect((await read([run(1, "completed"), run(2, "completed")], [start, delivery])).byMachine).toBe(true);
	});
	test("a run an instruction started is not, from any client", async () => {
		for (const creationSource of ["mcp", "web", "mobile"])
			expect((await read([run(1, "completed")], [{ ...start, creationSource }])).byMachine).toBe(false);
	});
	test("an instruction steered into a machine's run leaves it a machine's", async () => {
		const steer: TurnItem = { ...steward, id: "s2", runId: "r2" };
		const r = await read([run(1, "completed"), run(2, "completed")], [start, note("r2"), steer]);
		expect(r.byMachine).toBe(true);
		expect(stewardInstruction(r.items)).toBe("s2");
	});
	test("a newer run already going doesn't stand in for the one that ended", async () => {
		// A queued run has no items yet, and it can start inside the debounce before this read.
		expect(
			(await read([run(1, "completed"), run(2, "completed"), run(3, "queued")], [start, note("r2")])).byMachine,
		).toBe(true);
		expect((await read([run(1, "completed"), run(2, "running")], [start, note("r2")])).byMachine).toBe(false);
	});
	test("pages back for a run start that left the window, even with the instruction in hand", async () => {
		// A steered instruction is in the window, and the notification that started its run is one page back.
		const steer: TurnItem = { ...steward, id: "s2", runId: "r2" };
		const { get, asked } = t3(snapshot([run(1, "completed"), run(2, "completed")], [after("r2"), steer], "c1"), {
			c1: page([after("r1"), note("r2")]),
		});
		const r = await readInstruction("t", get);
		expect(asked).toHaveLength(2);
		expect(r.byMachine).toBe(true);
	});
	test("reads no pages when the run's start is in the window", async () => {
		const { get, asked } = t3(snapshot([run(1, "completed"), run(2, "completed")], [start, note("r2")], "c1"));
		expect((await readInstruction("t", get)).byMachine).toBe(true);
		expect(asked).toHaveLength(1);
	});
	test("a retained interrupt request at the window's end is not where a run began", async () => {
		// The instruction is in the window, so only the run's start can send the read back a page.
		const retained: TurnItem = { type: "run_interrupt_request", id: "x", runId: "r2" };
		const queued: TurnItem = { ...steward, id: "s2", runId: "r3" };
		const runs = [run(1, "completed"), run(2, "completed"), run(3, "queued")];
		const { get, asked } = t3(snapshot(runs, [queued, retained], "c1"), { c1: page([note("r2")]) });
		expect((await readInstruction("t", get)).byMachine).toBe(true);
		expect(asked).toHaveLength(2);
	});
	test("unknown is not a machine's, so the turn still counts", async () => {
		expect((await read([run(9, "completed")], [start])).byMachine).toBe(false);
		expect((await read([], [start])).byMachine).toBe(false);
	});
	test("a truncated read claims nothing about who started the turn", async () => {
		const endless = new Proxy({}, { has: () => true, get: () => page([note("r2")], "next") });
		const { get } = t3(
			snapshot([run(1, "completed"), run(2, "completed")], [note("r2")], "c1"),
			endless as Record<string, unknown>,
		);
		expect(await readInstruction("t", get)).toMatchObject({ state: "truncated", byMachine: false });
	});
});

describe("readWhenConnected", () => {
	test("with no connection the read fails without asking HTTP: its state may be stale", async () => {
		const noHttp = async () => {
			throw Error("HTTP must not be asked");
		};
		expect(await readWhenConnected(false, "t", noHttp)).toEqual({
			items: [],
			state: "failed",
			error: "not connected",
			byMachine: false,
		});
	});
});
