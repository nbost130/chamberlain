import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { addInForce, citations, citedIds, confirmRuling, editRuling, inForceRuling, nextId, propose, readRulings, renderInForce, retireRuling, rulingsText, updateRulings } from "./rulings.ts";
import { decisionRecord } from "./decided.ts";

/** A store holding eight rulings, as a long-running install would. */
const seeded = () => {
	const d = memStore();
	for (let i = 1; i <= 8; i++) addInForce(d, `words ${i}`, `Rule ${i}.`, i % 2 ? "chat" : "card", "stated in chat");
	return d;
};

describe("the table", () => {
	test("keeps rulings in id order with their history", () => {
		const d = seeded();
		expect(readRulings(d).map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
		expect(readRulings(d)[0]!.history).toHaveLength(1);
	});
	test("ids are allocated in order and orders past R9 sort by number, not text", () => {
		const d = seeded();
		addInForce(d, "w", "d", "chat", "x");
		addInForce(d, "w", "d", "chat", "x");
		expect(readRulings(d).map((r) => r.id).slice(-3)).toEqual(["R8", "R9", "R10"]);
		expect(nextId(readRulings(d))).toBe("R11");
	});
	test("an update that throws changes nothing, and one that edits saves only what changed", () => {
		const d = seeded();
		expect(() => updateRulings(d, (list) => { list[0]!.decides = "lost"; throw Error("no"); })).toThrow("no");
		expect(readRulings(d)[0]!.decides).toBe("Rule 1.");
		updateRulings(d, (list) => { list[1]!.decides = "changed"; });
		expect(readRulings(d).map((r) => r.decides).slice(0, 3)).toEqual(["Rule 1.", "changed", "Rule 3."]);
	});
	test("inForceRuling builds the next ruling without saving it", () => {
		const d = seeded();
		const r = inForceRuling(readRulings(d), "w", "d", "card", "on the page", "Q-abc12");
		expect(r).toMatchObject({ id: "R9", status: "in-force", confirmed: true, item: "Q-abc12" });
		expect(readRulings(d)).toHaveLength(8);
	});
});

describe("nothing goes in force without the principal's confirm", () => {
	test("a proposal is not in force and is left out of the hand-off text", () => {
		const d = seeded();
		const p = propose(d, "Approve (Recommended)", "Gates like this one are the Steward's");
		expect(p.status).toBe("proposed");
		expect(p.confirmed).toBe(false);
		expect(rulingsText(d)).not.toContain("Gates like this one");
	});
	test("confirm puts it in force with confirmed:true, and the hand-off carries it with its ID", () => {
		const d = seeded();
		const p = propose(d, "Approve (Recommended)", "Gates like this one are the Steward's");
		const c = confirmRuling(d, p.id, "Gates like this are the Steward's to clear");
		expect(c.status).toBe("in-force");
		expect(c.confirmed).toBe(true);
		expect(c.confirmedAt).toBeTruthy();
		expect(rulingsText(d)).toContain(`- ${p.id} (`);
		expect(rulingsText(d)).toContain("Gates like this are the Steward's to clear");
	});
	test("editing wording never confirms or enforces a proposal", () => {
		const d = seeded();
		const p = propose(d, "w", "first");
		const e = editRuling(d, p.id, "second");
		expect(e.status).toBe("proposed");
		expect(e.confirmed).toBe(false);
		expect(e.history?.some((h) => h.from === "first")).toBe(true);
	});
	test("retire and only-this-once take a ruling out of force", () => {
		const d = seeded();
		retireRuling(d, "R1", "retired");
		retireRuling(d, "R4", "only this once");
		const t = rulingsText(d);
		expect(t).not.toContain("- R1 ");
		expect(t).not.toContain("- R4 ");
		expect(readRulings(d).find((r) => r.id === "R4")!.retiredHow).toBe("only this once");
	});
	test("a rule stated in chat goes in force at once", () => {
		const d = seeded();
		const r = addInForce(d, "never deploy on Fridays", "No production deploys on Fridays.", "chat", "stated in chat");
		expect(r.status).toBe("in-force");
		expect(r.confirmed).toBe(true);
		expect(r.id).toBe("R9");
	});
	test("the hand-off marks unconfirmed card rulings and prefixes every line with its ID", () => {
		const d = seeded();
		// A card-sourced ruling that was never confirmed: written directly, as the page never does.
		updateRulings(d, (list) => { list[1]!.confirmed = false; });
		const lines = renderInForce(readRulings(d)).split("\n");
		expect(lines.every((l) => /^- R\d+ \(/.test(l))).toBe(true);
		expect(lines.find((l) => l.startsWith("- R2 "))).toContain("[unconfirmed");
		expect(lines.find((l) => l.startsWith("- R1 "))).not.toContain("[unconfirmed");
	});
	test("with no rulings there is no rulings text", () => expect(rulingsText(memStore())).toBe(""));
});

describe("citations by ID", () => {
	test("decided.ts takes leading IDs and keeps free text working", () => {
		expect(citedIds("R12")).toEqual(["R12"]);
		expect(citedIds("R12: merge conflicts are mine")).toEqual(["R12"]);
		expect(citedIds("R3, R7 + R9: both")).toEqual(["R3", "R7", "R9"]);
		expect(citedIds("Ada: 'merge conflicts are yours'")).toEqual([]);
		expect(citedIds("Round R2 of fixes")).toEqual([]);
		expect(decisionRecord("t", "d", "Ada said so", undefined).rulingIds).toBeUndefined();
		expect(decisionRecord("t", "d", "R4: release PRs", "ref").rulingIds).toEqual(["R4"]);
	});
	test("counts citations per ruling, newest first", () => {
		const c = citations([
			decisionRecord("a", "first", "R1", undefined, "2026-11-01T00:00:00Z"),
			decisionRecord("b", "second", "R1, R2", undefined, "2026-11-02T00:00:00Z"),
			decisionRecord("c", "free", "just text", undefined, "2026-11-03T00:00:00Z"),
		]);
		expect(c.get("R1")!.map((x) => x.decision)).toEqual(["second", "first"]);
		expect(c.get("R2")).toHaveLength(1);
		expect(c.size).toBe(2);
	});
});
