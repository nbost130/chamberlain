/** rules, continued: see rules.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { host, source, spec } from "../../testing/core-rules-fixtures.ts";
import { loadOperatingRules } from "./rules.ts";

describe("loadOperatingRules", () => {
	const dir = () => mkdtempSync(`${tmpdir()}/rules-`);
	test("nothing configured is empty", () => expect(loadOperatingRules(dir())).toBe(""));
	test("operating-rules.md is used whole", () => {
		const d = dir();
		writeFileSync(`${d}/operating-rules.md`, "Be kind.", { mode: 0o600 });
		expect(loadOperatingRules(d)).toBe("Be kind.");
	});
	test("a config excerpts its source; a section that is gone contributes nothing, loudly, and the source is never copied whole", () => {
		const d = dir();
		writeFileSync(`${d}/source.md`, source, { mode: 0o600 });
		writeFileSync(`${d}/operating-rules.json`, JSON.stringify({ source: `${d}/source.md`, sections: spec }), {
			mode: 0o600,
		});
		expect(loadOperatingRules(d)).not.toContain("Builder-only");
		writeFileSync(`${d}/source.md`, source.replace("## Secrets", "## Credentials"), { mode: 0o600 });
		const warned: string[] = [];
		const out = loadOperatingRules(d, (m) => warned.push(m));
		for (const s of ["Builder-only", "Never paste", "fast lane", "# Operating rules"]) expect(out).not.toContain(s);
		expect(out).toBe(
			"## Working style\n\n- Whole issue: finish a piece before starting the next.\n- Smallest change that works.",
		);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("WARNING");
		expect(warned[0]).toContain(`${d}/source.md`);
		expect(warned[0]).toContain('"Secrets"');
		expect(warned[0]).toContain("left out");
	});
	test("a table selector that finds two tables under its heading contributes nothing from that source, and the other sources still come out", () => {
		const d = dir();
		writeFileSync(`${d}/shared.md`, source, { mode: 0o600 });
		writeFileSync(`${d}/host.md`, host.replace("| Builder-only row", "\n| Builder-only row"), { mode: 0o600 });
		writeFileSync(
			`${d}/operating-rules.json`,
			JSON.stringify({
				sources: [
					{ path: `${d}/host.md`, sections: [{ table: "Deltas", rows: ["| Shell idioms"], as: "On this host" }] },
					{ path: `${d}/shared.md`, sections: spec },
				],
			}),
			{ mode: 0o600 },
		);
		const warned: string[] = [];
		const out = loadOperatingRules(d, (m) => warned.push(m));
		for (const s of ["Builder-only row", "Not wanted", "timeout", "Shell idioms", "On this host", "# This host"])
			expect(out).not.toContain(s);
		expect(out).toStartWith("## Secrets");
		expect(warned).toEqual([expect.stringContaining(`${d}/host.md`)]);
		expect(warned[0]).toContain("2 tables");
	});
	test('a missing table contributes nothing; a source copies whole only when it says "sections": "whole"', () => {
		const d = dir();
		writeFileSync(`${d}/host.md`, host, { mode: 0o600 });
		writeFileSync(`${d}/shared.md`, source, { mode: 0o600 });
		writeFileSync(
			`${d}/operating-rules.json`,
			JSON.stringify({
				sources: [
					{ path: `${d}/host.md`, sections: [{ table: "Gone", rows: "whole" }] },
					{ path: `${d}/shared.md`, sections: "whole" },
				],
			}),
			{ mode: 0o600 },
		);
		const warned: string[] = [];
		expect(loadOperatingRules(d, (m) => warned.push(m))).toBe(source.trimEnd());
		expect(warned).toEqual([expect.stringContaining('"Gone"')]);
	});
	test("several sources come out in order after the intro; a source that moved contributes nothing while the others are still excerpted", () => {
		const d = dir();
		writeFileSync(`${d}/shared.md`, source, { mode: 0o600 });
		writeFileSync(`${d}/host.md`, host, { mode: 0o600 });
		writeFileSync(
			`${d}/operating-rules.json`,
			JSON.stringify({
				intro: "Read the files for the rest.",
				sources: [
					{ path: `${d}/host.md`, sections: [{ table: "Deltas", rows: ["| Shell idioms"], as: "On this host" }] },
					{ path: `${d}/shared.md`, sections: spec },
				],
			}),
			{ mode: 0o600 },
		);
		const out = loadOperatingRules(d);
		expect(out).toStartWith("Read the files for the rest.\n\n## On this host\n\n| Rule | Here |");
		expect(out.indexOf("## On this host")).toBeLessThan(out.indexOf("## Secrets"));
		for (const s of ["Builder-only", "Not wanted", "timeout"]) expect(out).not.toContain(s);
		writeFileSync(`${d}/host.md`, host.replace("| Shell idioms", "| Shells"), { mode: 0o600 });
		const warned: string[] = [];
		const fell = loadOperatingRules(d, (m) => warned.push(m));
		expect(fell).not.toContain("Builder-only");
		expect(fell).not.toContain("On this host");
		expect(fell).toStartWith("Read the files for the rest.\n\n## Secrets");
		expect(warned).toEqual([expect.stringContaining(`${d}/host.md`)]);
	});
	test("a world-readable rules config is refused", () => {
		const d = dir();
		writeFileSync(`${d}/operating-rules.md`, "x", { mode: 0o644 });
		expect(() => loadOperatingRules(d)).toThrow("0600");
	});
});
