import { describe, expect, test } from "bun:test";
import { t3ServerLine } from "./index.ts";
import { isWaitKind, normalizeWaitKind, toState } from "./state.ts";

describe("toState", () => {
	test("toState reads lineage, pending request, settled and snooze", () => {
		const now = Date.parse("2026-10-31T12:00:00Z");
		const s = toState({ id: "x", title: "y", status: "idle", lineage: { parentThreadId: "p" }, pendingRuntimeRequest: { id: "r" },
			settledAt: "2026-10-30T00:00:00Z", snoozedUntil: "2026-11-02T00:00:00Z" }, now);
		expect(s).toMatchObject({ parentThreadId: "p", pendingRequestId: "r", settled: true, snoozed: true });
		expect(toState({ id: "x", settledAt: "a", unsettledAt: "b" }, now).settled).toBe(false);
	});
});

describe("toState open work", () => {
	const pr = (number: number, state: string) => ({ number, snapshot: { state } });
	test("counts only pull requests T3 last saw open", () => expect(toState({ id: "t", pullRequests: [pr(1, "merged"), pr(2, "open"), pr(3, "closed")] }).openPrs).toEqual([2]));
	test("a pull request listed twice counts once", () => expect(toState({ id: "t", pullRequests: [pr(2, "open"), pr(2, "open")] }).openPrs).toEqual([2]));
	test("the branch pull request has no state, as T3 sends it, and adds nothing", () => expect(toState({ id: "t", branchPullRequest: { number: 2, repository: "r" } }).openPrs).toEqual([]));
	test("a merged or closed link marks the work done", () => {
		expect(toState({ id: "t", pullRequests: [pr(4, "merged")] }).linkedPrDone).toBe(true);
		expect(toState({ id: "t", pullRequests: [pr(4, "closed")] }).linkedPrDone).toBe(true);
		expect(toState({ id: "t", pullRequests: [pr(4, "open")] }).linkedPrDone).toBe(false);
	});
	test("a thread with nothing has no open work", () => {
		const s = toState({ id: "t" });
		expect([s.openPrs, s.worktreePath, s.linkedPrDone, s.backgroundTasks]).toEqual([[], null, false, 0]);
	});
});


describe("background work", () => {
	test("a watched PR is not work, or a report would wait on it for days", () => {
		const t = toState({ id: "t", pendingBackgroundTasks: [{ taskId: "pull-request-watch:github#1", kind: "monitor" }, { taskId: "b1", kind: "command" }] });
		expect(t.backgroundTasks).toBe(2);
		expect(t.backgroundWork).toBe(1);
	});
});

describe("waiting kinds", () => {
	test("every spelling of a link request is one kind, and the others pass through", () => {
		expect(normalizeWaitKind("machine_link_request")).toBe("link_request");
		expect(normalizeWaitKind("link-request")).toBe("link_request");
		expect(normalizeWaitKind("link_request")).toBe("link_request");
		expect(normalizeWaitKind("approval_request")).toBe("approval_request");
		expect(isWaitKind("user_input_request")).toBe(true);
		expect(isWaitKind("assistant_message")).toBe(false);
	});
});

describe("t3ServerLine", () => {
	test("a linked server names its environment id", () => {
		expect(t3ServerLine({ name: "remote", environmentId: "abc" })).toContain("environmentId abc");
	});
	test("this server needs none", () => {
		expect(t3ServerLine({ name: "main" })).toBe("server: main (this server)");
	});
});
