import { describe, expect, test } from "bun:test";
import { endKind, looksLikeAsk } from "./decide.ts";
import { looksLikeWait, waitClosing } from "./wait-phrases.ts";

/** Pilot B closing from 2026-11-15 (Omar / MemberHero). */
const PILOT_B = "I'm holding until you send C's exact application SHA. No further commits from this thread until then.";
/** Pilot C closing from 2026-11-15. */
const PILOT_C = "Parked after the Steward rules on PR-G. No reply needed while that ruling is open.";

describe("wait phrases: Pilot B and C closings", () => {
	test("Pilot B holding-until is a wait and an ask", () => {
		expect(looksLikeWait(PILOT_B)).toBe(true);
		expect(looksLikeAsk(PILOT_B)).toBe(true);
		expect(endKind(PILOT_B)).toBe("ask");
		expect(waitClosing(PILOT_B)?.awaiting).toContain("C's exact application SHA");
	});
	test("Pilot C steward-wait / no-reply-needed is a wait and an ask", () => {
		expect(looksLikeWait(PILOT_C)).toBe(true);
		expect(looksLikeAsk(PILOT_C)).toBe(true);
		expect(endKind(PILOT_C)).toBe("ask");
		expect(waitClosing(PILOT_C)?.awaiting.toLowerCase()).toMatch(/steward|ruling|pr-g/);
	});
	test("I'll adapt once is a wait", () => {
		const t = "I'll adapt once the coordinator posts the merge SHA.";
		expect(looksLikeWait(t)).toBe(true);
		expect(waitClosing(t)?.awaiting).toContain("coordinator");
	});
	test("no reply needed while … is a wait", () => {
		const t = "No reply needed while the principal decides the redesign.";
		expect(looksLikeWait(t)).toBe(true);
		expect(waitClosing(t)?.awaiting).toContain("principal");
	});
	test("a plain done line is not a wait", () => {
		expect(looksLikeWait("All done and verified.")).toBe(false);
		expect(waitClosing("Merged and deployed.")).toBeUndefined();
	});
});
