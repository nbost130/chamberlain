/** decide, continued: see decide.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { base, none } from "../../testing/core-decide-fixtures.ts";
import { normalizeThread } from "../adapter/adapter.ts";
import {
	decide,
	idleKey,
	idleWorkLine,
	PRINCIPAL_HERE_MS,
	principalWroteWithin,
	reportKey,
	reportStillDue,
	rightsInFull,
	stewardInstruction,
	type ThreadState,
	turnBegan,
} from "./decide.ts";

describe("stewardInstruction", () => {
	const steward = {
		type: "user_message",
		id: "s1",
		text: "Steward here. Push the fix.",
		createdBy: "agent",
		creationSource: "mcp",
	};
	const reply = {
		type: "assistant_message",
		id: "a1",
		text: "Pushed.",
		createdBy: "agent",
		creationSource: "provider",
	};
	test("the Steward's message is the latest instruction", () =>
		expect(stewardInstruction([steward, reply])).toBe("s1"));
	test("PR updates, card answers and delegate results instruct nobody", () => {
		const pr = {
			type: "user_message",
			id: "p",
			text: "Update on pull request #1",
			createdBy: "agent",
			creationSource: "server",
		};
		const card = { type: "user_message", id: "c", text: "Approve?", createdBy: "user", creationSource: "server" };
		expect(stewardInstruction([steward, reply, pr, reply, card, reply])).toBe("s1");
	});
	test("the operator speaking after it makes the thread his", () => {
		expect(
			stewardInstruction([
				steward,
				reply,
				{ type: "user_message", id: "n", text: "Why?", createdBy: "user", creationSource: "mobile" },
				reply,
			]),
		).toBeUndefined();
	});
	test("another agent's message does not count", () => {
		expect(
			stewardInstruction([
				{ type: "user_message", id: "o", text: "Stewardship notes", createdBy: "agent", creationSource: "mcp" },
			]),
		).toBeUndefined();
		expect(
			stewardInstruction([
				{ type: "user_message", id: "o", text: "Please look at this", createdBy: "agent", creationSource: "mcp" },
			]),
		).toBeUndefined();
	});
	test("nothing in the thread means nothing to report", () => expect(stewardInstruction([])).toBeUndefined());
});

describe("rightsInFull", () => {
	const sent = { hash: "a", used: 80_000 };
	test("the first wake after a start carries them", () => expect(rightsInFull(undefined, "a", 80_000)).toBe(true));
	test("a change to the rights carries them", () => expect(rightsInFull(sent, "b", 90_000)).toBe(true));
	test("a compaction carries them, because the context shrank", () =>
		expect(rightsInFull(sent, "a", 50_000)).toBe(true));
	test("must skip: a size that could not be read just now is not a shrink; the minute check owns that", () =>
		expect(rightsInFull(sent, "a", undefined)).toBe(false));
	test("a record with no size mark has nothing to tell a shrink by, so doubt carries them", () =>
		expect(rightsInFull({ hash: "a" }, "a", 80_000)).toBe(true));
	test("a small dip under the mark (the reading wobbling) is not a compaction", () =>
		expect(rightsInFull(sent, "a", 70_000)).toBe(false));
	test("an ordinary next wake sends the short line", () => {
		expect(rightsInFull(sent, "a", 80_000)).toBe(false);
		expect(rightsInFull(sent, "a", 95_000)).toBe(false);
	});
});

describe("reportStillDue", () => {
	const t = (o: Partial<ThreadState>): ThreadState => ({
		...normalizeThread({ id: "t", title: "", status: "completed" }),
		...o,
	});
	const old = new Set(["card-old"]);
	test("no card: the report goes", () => expect(reportStillDue(t({}), old)).toBe(true));
	test("the 2026-11-07 miss: an older open card no longer cancels it", () =>
		expect(reportStillDue(t({ pendingRequestId: "card-old" }), old)).toBe(true));
	test("an older card that holds the thread at waiting does not cancel it either", () =>
		expect(reportStillDue(t({ status: "waiting", pendingRequestId: "card-old" }), old)).toBe(true));
	test("a card raised since the turn began still wins", () =>
		expect(reportStillDue(t({ pendingRequestId: "card-new" }), old)).toBe(false));
	test("a card is new when nothing was seen before the turn", () =>
		expect(reportStillDue(t({ pendingRequestId: "card-old" }), new Set())).toBe(false));
	test("a thread working again stays quiet", () => {
		expect(reportStillDue(t({ status: "running" }), old)).toBe(false);
		expect(reportStillDue(t({ status: "running", pendingRequestId: "card-old" }), old)).toBe(false);
		expect(reportStillDue(t({ status: "waiting" }), old)).toBe(false);
	});
	test("a settled, archived or snoozed thread stays quiet", () => {
		for (const o of [{ settled: true }, { archived: true }, { snoozed: true }])
			expect(reportStillDue(t(o), old)).toBe(false);
	});
});

describe("idleKey", () => {
	const now = Date.parse("2026-11-07T02:00:00Z");
	const msg = (id: string, createdBy: string, creationSource: string, minsAgo = 60) => ({
		type: "user_message",
		id,
		createdBy,
		creationSource,
		updatedAt: new Date(now - minsAgo * 60_000).toISOString(),
	});
	test("keys on the latest instruction, so a thread wakes once per instruction", () =>
		expect(idleKey([msg("a", "user", "web"), msg("b", "agent", "mcp")], now)).toBe("idle:b"));
	test("the operator's recent message means he is already there", () => {
		expect(idleKey([msg("a", "user", "mobile", 5)], now)).toBeUndefined();
		expect(idleKey([msg("a", "user", "mobile", PRINCIPAL_HERE_MS / 60_000 + 1)], now)).toBe("idle:a");
	});
	test("an agent's recent message does not count as the operator being there", () =>
		expect(idleKey([msg("a", "agent", "mcp", 1)], now)).toBe("idle:a"));
	test("machine deliveries instruct nobody", () =>
		expect(idleKey([msg("a", "agent", "mcp"), msg("b", "user", "server", 1)], now)).toBe("idle:a"));
	test("no instruction, no wake", () => expect(idleKey([], now)).toBeUndefined());
});

test("idleWorkLine names the work", () => {
	expect(idleWorkLine([12, 13], 0)).toBe("open PR #12, #13");
	expect(idleWorkLine([], 1)).toBe("1 unmerged commit on its branch and no open PR");
	expect(idleWorkLine([], 4)).toBe("4 unmerged commits on its branch and no open PR");
});

describe("turnBegan", () => {
	const s = (status: string) => normalizeThread({ id: "t", title: "", status });
	test("a thread waiting on a card that goes back to work has begun a turn", () =>
		expect(turnBegan(s("waiting"), s("running"))).toBe(true));
	test("an idle thread that starts has begun a turn", () => {
		expect(turnBegan(s("completed"), s("running"))).toBe(true);
		expect(turnBegan(s("idle"), s("queued"))).toBe(true);
	});
	test("raising a card mid-turn is not a new turn", () => expect(turnBegan(s("running"), s("waiting"))).toBe(false));
	test("moving between working states is not a new turn", () =>
		expect(turnBegan(s("queued"), s("running"))).toBe(false));
	test("a thread first seen after a restart is not a turn start", () =>
		expect(turnBegan(undefined, s("running"))).toBe(false));
});

test("the 2026-11-07 miss, end to end: a card open while waiting, then the Steward's turn, then the turn ends", () => {
	const seen = new Set<string>();
	let old = new Set<string>();
	const step = (prev: ThreadState | undefined, next: ThreadState) => {
		if (turnBegan(prev, next)) old = new Set(seen);
		if (next.pendingRequestId) seen.add(next.pendingRequestId);
	};
	const s = (status: string) => ({ ...normalizeThread({ id: "t", title: "", status }), pendingRequestId: "x" });
	step(normalizeThread({ id: "t", title: "", status: "running" }), s("waiting"));
	step(s("waiting"), s("running"));
	step(s("running"), s("completed"));
	expect(reportStillDue(s("completed"), old)).toBe(true);
});

describe("principalWroteWithin", () => {
	const now = Date.parse("2026-11-07T02:00:00Z");
	const HOUR = 3_600_000;
	const msg = (createdBy: string, creationSource: string, hoursAgo: number) => ({
		type: "user_message",
		id: "m",
		createdBy,
		creationSource,
		updatedAt: new Date(now - hoursAgo * HOUR).toISOString(),
	});
	test("his own recent message means he is driving the thread", () =>
		expect(principalWroteWithin([msg("user", "mobile", 1)], now, 2 * HOUR)).toBe(true));
	test("an old message of his does not", () =>
		expect(principalWroteWithin([msg("user", "mobile", 3)], now, 2 * HOUR)).toBe(false));
	test("an agent's later instruction means he is not", () =>
		expect(principalWroteWithin([msg("user", "web", 1), msg("agent", "mcp", 0.5)], now, 2 * HOUR)).toBe(false));
	test("a machine delivery changes nothing", () =>
		expect(principalWroteWithin([msg("user", "web", 1), msg("user", "server", 0.1)], now, 2 * HOUR)).toBe(true));
	test("no messages, not driving", () => expect(principalWroteWithin([], now, 2 * HOUR)).toBe(false));
});

describe("reportKey", () => {
	const steward = { type: "user_message", id: "s1", text: "Steward: go", createdBy: "agent", creationSource: "mcp" };
	test("an instruction's turn spends the three in order, then stops", () => {
		expect(reportKey([steward], false, new Set())).toBe("report:s1:0");
		expect(reportKey([steward], false, new Set(["report:s1:0", "report:s1:1"]))).toBe("report:s1:2");
		expect(reportKey([steward], false, new Set(["report:s1:0", "report:s1:1", "report:s1:2"]))).toBeUndefined();
	});
	test("a machine's turn still reports after the three are gone", () => {
		expect(reportKey([steward], true, new Set(["report:s1:0", "report:s1:1", "report:s1:2"]))).toBe(
			"report:s1:machine",
		);
	});
	test("nobody's instruction but the Steward's", () => {
		expect(reportKey([{ ...steward, text: "go" }], false, new Set())).toBeUndefined();
	});
});

describe("the failure dedupe key names the run (2026-11-13: a second failure was swallowed)", () => {
	const failedKeys = (prev: ThreadState, next: ThreadState) =>
		decide(prev, next, none)
			.filter((c) => c.kind === "failed")
			.map((c) => c.key);

	test("two failures of one thread on different runs get different keys, so both fire", () => {
		const first = failedKeys({ ...base, latestRunId: "run-1" }, { ...base, status: "failed", latestRunId: "run-1" });
		const second = failedKeys({ ...base, latestRunId: "run-2" }, { ...base, status: "failed", latestRunId: "run-2" });
		expect(first).toEqual(["t1:failed:run-1:running"]);
		expect(second).toEqual(["t1:failed:run-2:running"]);
		expect(first[0]).not.toBe(second[0]);
	});

	test("the same run seen failing twice keeps one key, so it still fires once", () => {
		const a = failedKeys({ ...base, latestRunId: "run-1" }, { ...base, status: "failed", latestRunId: "run-1" });
		const b = failedKeys({ ...base, latestRunId: "run-1" }, { ...base, status: "failed", latestRunId: "run-1" });
		expect(a).toEqual(b);
	});

	test("a backend that names no run keeps the old key", () => {
		expect(failedKeys(base, { ...base, status: "failed" })).toEqual(["t1:failed:running"]);
	});

	test("normalizeThread carries the run id through", () => {
		expect(normalizeThread({ id: "t", title: "T", status: "failed", latestRunId: "run-9" }).latestRunId).toBe("run-9");
	});
});
