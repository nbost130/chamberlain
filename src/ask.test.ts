import { describe, expect, test } from "bun:test";
import { parseAsk } from "./ask.ts";

const base = { kind: "ruling", title: "Pick", context: "- a", options: ["A", "B"], thread: "t", server: "main", proposedRuling: "Do it this way for this launch." };
const NOW = new Date().toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("proposedExpires on a question", () => {
	test("a future date or date-time is kept on the item", () => {
		expect(parseAsk({ ...base, proposedExpires: inDays(30) }, "Q-abc12", NOW).proposedExpires).toBe(inDays(30));
		const dt = new Date(Date.now() + 3_600_000).toISOString();
		expect(parseAsk({ ...base, proposedExpires: ` ${dt} ` }, "Q-abc12", NOW).proposedExpires).toBe(dt);
	});
	test("a question without one has none", () => {
		expect(parseAsk(base, "Q-abc12", NOW)).not.toHaveProperty("proposedExpires");
	});
	test("it needs a proposed ruling", () => {
		const { proposedRuling: _p, ...noRuling } = base;
		expect(() => parseAsk({ ...noRuling, proposedExpires: inDays(30) }, "Q-abc12", NOW)).toThrow("proposedExpires needs a proposedRuling");
	});
	test("an unreadable, zoneless, impossible or past value is refused", () => {
		for (const bad of ["next week", `${inDays(3)}T09:00:00`]) expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow("proposedExpires must be an ISO date");
		for (const bad of ["2026-02-30", "2099-02-30T09:00:00Z", "2099-02-29T09:00:00Z", "2099-13-01T09:00:00Z", "2099-11-13T24:00:00Z"]) expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow(`proposedExpires "${bad}" is not a real date and time`);
		expect(parseAsk({ ...base, proposedExpires: "2096-02-29T09:00:00Z" }, "Q-abc12", NOW).proposedExpires).toBe("2096-02-29T09:00:00Z");
		expect(() => parseAsk({ ...base, proposedExpires: "2020-01-01" }, "Q-abc12", NOW)).toThrow("proposedExpires is already past");
		expect(() => parseAsk({ ...base, proposedExpires: 5 }, "Q-abc12", NOW)).toThrow("must be a string");
	});
});
