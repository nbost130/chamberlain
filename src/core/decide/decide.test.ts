import { describe, expect, test } from "bun:test";
import { base, none } from "../../testing/core-decide-fixtures.ts";
import {
	decide,
	endKind,
	looksLikeAsk,
	looksLikeStall,
	needsCompact,
	questionText,
	routeNeedsInput,
} from "./decide.ts";

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
	test("a queued handoff (LIVE→LIVE, new latestRunId) is a turn_ended keyed by the completed run", () => {
		const prev = { ...base, status: "running", latestRunId: "run-20" };
		const next = { ...base, status: "running", latestRunId: "run-21" };
		const a = decide(prev, next, none);
		expect(a.map((c) => c.kind)).toEqual(["turn_ended"]);
		expect(a[0]!.key).toBe("t1:ended:run-20");
		expect(decide(prev, { ...prev }, none)).toEqual([]);
		expect(decide({ ...base, status: "completed", latestRunId: "run-20" }, next, none)).toEqual([]);
		const child = { ...prev, parentThreadId: "p" };
		expect(decide(child, { ...child, latestRunId: "run-21" }, none)).toEqual([]);
	});
	test("idle-gap and handoff keys name the same completed run, so they cannot both wake", () => {
		const idle = decide(
			{ ...base, status: "running", latestRunId: "run-1" },
			{ ...base, status: "completed", latestRunId: "run-1" },
			none,
		);
		const handoff = decide(
			{ ...base, status: "running", latestRunId: "run-1" },
			{ ...base, status: "running", latestRunId: "run-2" },
			none,
		);
		expect(idle[0]!.key).toBe("t1:ended:run-1");
		expect(handoff[0]!.key).toBe("t1:ended:run-1");
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

describe("looksLikeAsk: a want-me-to question said only in the spoken closing line", () => {
	test("is an ask, and endKind says so (a review finding)", () => {
		for (const t of [
			"Done.\n🗣️ Agent: Want me to proceed?",
			"Done.\n\n🗣️ Agent: [steady] The fix is in. Do you want me to open the PR?",
			"Built.\n\n🗣️ Shall I merge it?",
		]) {
			expect(looksLikeAsk(t)).toBe(true);
			expect(endKind(t)).toBe("ask");
		}
	});
	test("an ordinary closing line is still not an ask", () => {
		for (const t of [
			"All done and verified.\n\n🗣️ Agent: Done?",
			"Done.\n\n🗣️ Agent: Finished; there is nothing you want me to do.",
			"Done.\n\n🗣️ Agent: You wanted me to fix it, and I did.",
			"Done.\n\n🗣️ Agent: Report is with the Steward.",
		]) {
			expect(looksLikeAsk(t)).toBe(false);
			expect(endKind(t)).toBe("plain");
		}
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
