import { describe, expect, test } from "bun:test";
import { normalizeThread } from "./adapter.ts";
import {
	decide,
	endKind,
	principalWroteWithin,
	reportKey,
	turnBegan,
	idleKey,
	idleWorkLine,
	looksLikeAsk,
	PRINCIPAL_HERE_MS,
	reportStillDue,
	rightsInFull,
	looksLikeStall,
	needsCompact,
	questionText,
	routeNeedsInput,
	stewardInstruction,
	type ThreadState,
} from "./decide.ts";

const base: ThreadState = {
	id: "t1",
	title: "T",
	status: "running",
	parentThreadId: null,
	pendingRequestId: null,
	settled: false,
	archived: false,
	snoozed: false,
	blockedOnThreadWait: false,
	openPrs: [],
	worktreePath: null,
	linkedPrDone: false,
	backgroundTasks: 0,
	backgroundWork: 0,
};
const none = new Set<string>();

describe("decide", () => {
	test("first sighting fires nothing unless a request is pending (watcher restart)", () => {
		expect(decide(undefined, base, none)).toEqual([]);
		const a = decide(undefined, { ...base, pendingRequestId: "r1" }, none);
		expect(a.map((c) => c.kind)).toEqual(["needs_input"]);
		expect(a[0].key).toBe("t1:input:r1");
		expect(decide(undefined, { ...base, pendingRequestId: "r1", snoozed: true }, none)).toEqual([]);
	});
	test("new pending request fires needs_input, once per request id", () => {
		const a = decide(base, { ...base, pendingRequestId: "r1" }, none);
		expect(a.map((c) => c.kind)).toEqual(["needs_input"]);
		expect(decide({ ...base, pendingRequestId: "r1" }, { ...base, pendingRequestId: "r1" }, none)).toEqual([]);
	});
	test("a child thread asking still fires", () => {
		const child = { ...base, parentThreadId: "p" };
		expect(decide(child, { ...child, pendingRequestId: "r2" }, none).map((c) => c.kind)).toEqual(["needs_input"]);
	});
	test("failure and turn end fire only for top-level threads", () => {
		expect(decide(base, { ...base, status: "failed" }, none).map((c) => c.kind)).toEqual(["failed"]);
		expect(decide(base, { ...base, status: "completed" }, none).map((c) => c.kind)).toEqual(["turn_ended"]);
		const child = { ...base, parentThreadId: "p" };
		expect(decide(child, { ...child, status: "failed" }, none)).toEqual([]);
		expect(decide(child, { ...child, status: "completed" }, none)).toEqual([]);
	});
	test("excluded, snoozed, settled and archived threads are silent", () => {
		const n = { ...base, status: "completed" };
		expect(decide(base, n, new Set(["t1"]))).toEqual([]);
		for (const k of ["snoozed", "settled", "archived"] as const)
			expect(decide(base, { ...n, [k]: true }, none)).toEqual([]);
	});
	test("a parent blocked on a child wait is not asking the operator", () => {
		expect(
			decide({ ...base, status: "running" }, { ...base, status: "waiting", blockedOnThreadWait: true }, none),
		).toEqual([]);
	});
});

describe("looksLikeAsk", () => {
	test("an OPEN section is an ask", () =>
		expect(looksLikeAsk("Done.\n\n❓ OPEN:\n\n1. Ship it?\n\n🗣️ Agent: ok")).toBe(true));
	test("a trailing question is an ask", () => expect(looksLikeAsk("I finished A. Want me to do B?")).toBe(true));
	test("a plain completion is not", () => expect(looksLikeAsk("All done and verified.\n\n🗣️ Agent: Done?")).toBe(false));
	test("a hand-back phrase is an ask", () =>
		expect(looksLikeAsk("Everything else is done. Tell me when it is plugged in and I will run it.")).toBe(true));
	test("a closing offer is an ask", () => expect(looksLikeAsk("It is built. Say if you want it.")).toBe(true));
	test("empty is not", () => expect(looksLikeAsk("")).toBe(false));
	test("a still-waiting line with no trailing question mark is an ask", () =>
		expect(
			looksLikeAsk(
				"Git tidy done.\n\n3. Still waiting on your answer: all four places, or staging only? The secret card stays closed until you decide.",
			),
		).toBe(true));
	test("a hand-back said only in the spoken closing line is an ask (a real miss)", () =>
		expect(
			looksLikeAsk(
				"**The independent review returned PASS for `076072df`.** The compatibility fix is complete and reviewed; nothing is installed or activated.\n\nThe reviewer independently verified reconnect, launch-then-connect, and symlink-swap cases. The swap left the victim unchanged.\n\nTwo older tests still fail on macOS due to fixture assumptions. Installation safeguards and acceptance against the real pinned browser context remain outstanding, so this is **build approval, not live readiness**.\n\n🗣️ Agent: [steady] The fix passed independent review. I’m handing it back before activation, as agreed.",
			),
		).toBe(true));
	test("a hold on the operator's last approval is an ask (a real miss)", () =>
		expect(
			looksLikeAsk(
				"Next is **installation preparation and live acceptance**. The code passed review, but the trusted launcher and protected bundle still need to be built and verified.\n\n1. Prepare the fixed launcher, protected runtime storage and version-pinned bundle; resolve the test-fixture gaps.\n\n2. Review those installation protections before activation, keeping the existing guard unchanged.\n\n3. Run the dedicated operation against the real isolated browser context and capture `READY` with exit **0**.\n\nYour last approval covered the fix and review only, so installation remains held.\n\n🧠 memory 6/6 fresh\n\n🗣️ Agent: [steady] The code is reviewed. Next I need to prove the protected installation and real browser readiness.",
			),
		).toBe(true));
	test("each hand-back phrase alone is an ask", () => {
		for (const t of [
			"Built.\n\nInstallation remains held.",
			"Done; held until your go.",
			"Parked, held for your sign-off.",
			"Your approval covered the review only.",
			"This needs your approval.",
			"It needs your go-ahead to ship.",
			"Reviewed, stopping before activation.",
		])
			expect(looksLikeAsk(t)).toBe(true);
	});
	test("an ordinary completion report is not an ask", () => {
		expect(looksLikeAsk("PR #957 remains ready and unmerged; the completion report is already with the Steward.")).toBe(
			false,
		);
		expect(
			looksLikeAsk(
				"Tests pass and the branch is pushed. The result was handed back to the Steward.\n\n🗣️ Agent: [steady] Finished; the report is with the Steward.",
			),
		).toBe(false);
		expect(looksLikeAsk("The deploy ran fine. The rollout stays held in staging by design, which is the plan.")).toBe(
			false,
		);
		expect(looksLikeAsk("Done. I am handing it back to the Steward now.")).toBe(false);
	});
	test("a /goal proposal is an ask", () =>
		expect(
			looksLikeAsk(
				"### 🎯 Proposed goal\n\n```markdown\n/goal Make PR #1 green.\n```\n\nSubmit the /goal block as-is, edit it, or say 'no goal' to proceed without one.\n\n🗣️ Agent: proposal ready.",
			),
		).toBe(true));
});

describe("looksLikeAsk go-phrases", () => {
	// The real miss: the go-line sat only in the spoken closing line, and both the body read and the stall rule drop that line.
	const REAL =
		"The token is in place, and the breaker still needs its metrics endpoint built.\n\n- **Not configured yet:** there is no gate file either.\n\n🗣️ The token's in place, Sir. The breaker still needs its metrics endpoint built; say go and I'll start it.";
	test("the real line, said only in the spoken closing line, is an ask", () => expect(looksLikeAsk(REAL)).toBe(true));
	test("the same line in the body is an ask too", () =>
		expect(looksLikeAsk("The endpoint is not built yet. Say go and I'll start it.")).toBe(true));
	test("each go-phrase alone is an ask", () => {
		for (const t of [
			"Built. Say go.",
			'Built. Say "go" when ready.',
			"Built. SAY GO and it ships.",
			"Built. Give me the go and I ship it.",
			"Built. Give the go when you are at a keyboard.",
			"Built. I am waiting on the go-ahead.",
			"Built. Go ahead?",
			"Everything is staged, ready when you are.",
			"Staged. Moving on your word.",
		])
			expect(looksLikeAsk(t)).toBe(true);
	});
	test("ordinary uses of go are not asks", () => {
		for (const t of [
			"I'll go ahead and run the tests.",
			"Then go to the settings page and click Save.",
			"The tests ran and the build is green. Things will go well from here.",
			"The job is good to go.",
			"Logging, which says good things about the run.",
			"It is ready when the queue drains, which it did.",
			"The worker runs on your wordpress host.",
		])
			expect(looksLikeAsk(t)).toBe(false);
	});
});

describe("endKind: an ask beats a stall", () => {
	test("'say go and I'll start it' matches the stall rule alone, and is classed an ask", () => {
		const t = "The endpoint is not built yet. Say go and I'll start it.";
		expect(looksLikeStall(t)).toBe(true);
		expect(endKind(t)).toBe("ask");
	});
	test("a stall that asks nothing stays a stall", () =>
		expect(endKind("Slice 1 merged. Slice 2 starts next.")).toBe("stall"));
	test("a plain completion is plain", () => expect(endKind("All done and verified.")).toBe("plain"));
	test("a trailing question beats a 'next up' promise", () =>
		expect(endKind("Slice 1 merged. Next up is slice 2. Want me to start it now?")).toBe("ask"));
});

describe("looksLikeStall", () => {
	test("a 'starts next' promise is a stall", () =>
		expect(looksLikeStall("Slice 1 merged.\n| 2 Slice 2 | ⏳ starts next |\n\n🗣️ Agent: ok")).toBe(true));
	test("an I'll-now-begin promise is a stall", () =>
		expect(looksLikeStall("Merged. I'll now begin the gate work.")).toBe(true));
	test("a wait-then-I-will promise is a stall", () =>
		expect(looksLikeStall("Three bake jobs are still running. When they finish I'll judge every room.")).toBe(true));
	test("a stays-working-until promise is a stall", () =>
		expect(looksLikeStall("This thread stays working until both finish.")).toBe(true));
	test("a plain completion is not", () => expect(looksLikeStall("All done and verified.")).toBe(false));
	test("a promise only in the voice closer is ignored", () =>
		expect(looksLikeStall("Done.\n\n🗣️ Agent: Slice two starts next.")).toBe(false));
	test("empty is not", () => expect(looksLikeStall("")).toBe(false));
});

describe("routeNeedsInput", () => {
	const q = { type: "user_input_request", requestId: "q" };
	const a = { type: "approval_request", requestId: "a" };
	const sec = { type: "secret_request", requestId: "s" };
	test("a waiting thread with nothing behind it is skipped", () =>
		expect(routeNeedsInput([], false, false)).toBe("skip-empty"));
	test("a pending request the projection has not caught up on still wakes", () =>
		expect(routeNeedsInput([], true, false)).toBe("wake"));
	test("a question always wakes, away or not", () => {
		expect(routeNeedsInput([q], true, false)).toBe("wake");
		expect(routeNeedsInput([q], true, true)).toBe("wake");
		expect(routeNeedsInput([q, a], true, true)).toBe("wake");
	});
	test("approvals and secrets are held in code while away, wake when present", () => {
		expect(routeNeedsInput([a], true, true)).toBe("hold");
		expect(routeNeedsInput([a, sec], true, true)).toBe("hold");
		expect(routeNeedsInput([a], true, false)).toBe("wake");
	});
	test("a machine-link card is held while away (adapters hand over the one kind, link_request)", () => {
		expect(routeNeedsInput([{ type: "link_request", requestId: "l" }], true, true)).toBe("hold");
		expect(routeNeedsInput([{ type: "link_request", requestId: "l" }, a], true, true)).toBe("hold");
	});
	test("a question beside a link card still wakes", () => {
		expect(routeNeedsInput([q, { type: "link_request", requestId: "l" }], true, true)).toBe("wake");
	});
});

describe("needsCompact", () => {
	test("past the limit, outside the cooldown", () => {
		expect(needsCompact(200_001, 200_000, false)).toBe(true);
		expect(needsCompact(200_001, 200_000, true)).toBe(false);
	});
	test("at or under the limit, or unknown, never", () => {
		expect(needsCompact(200_000, 200_000, false)).toBe(false);
		expect(needsCompact(undefined, 200_000, false)).toBe(false);
	});
});

describe("questionText", () => {
	test("carries the question and its options", () => {
		const t = questionText([{ question: "Which?", options: [{ label: "A", description: "first" }, { label: "B" }] }]);
		expect(t).toBe("Which?\n- A: first\n- B");
	});
	test("is empty with no questions", () => {
		expect(questionText([])).toBe("");
	});
	test("clips a long question", () => {
		expect(questionText([{ question: "x".repeat(50) }], 10)).toBe("xxxxxxxxxx…");
	});
});

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
	test("an unknown context size carries them, so doubt fails safe", () => {
		expect(rightsInFull(sent, "a", undefined)).toBe(true);
		expect(rightsInFull({ hash: "a" }, "a", 80_000)).toBe(true);
	});
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
