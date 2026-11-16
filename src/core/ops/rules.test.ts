import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { host, source, spec } from "../../testing/core-rules-fixtures.ts";
import { excerptRules, parseRulesConfig } from "./rules.ts";

describe("excerptRules", () => {
	const out = excerptRules(source, spec);
	test("keeps whole sections and the chosen lines", () => {
		for (const s of [
			"Never paste or echo a secret",
			"Enter secrets only",
			"Whole issue: finish a piece",
			"Smallest change that works",
		])
			expect(out).toContain(s);
	});
	test("drops what was not chosen", () => {
		for (const s of ["Builder-only note", "fast lane"]) expect(out).not.toContain(s);
	});
	test("a rule that moved stops the build", () => {
		expect(() => excerptRules(source.replace("- Smallest change that works.", "- Keep changes small."), spec)).toThrow(
			"Smallest change",
		);
		expect(() => excerptRules(source.replace("## Secrets", "## Credentials"), spec)).toThrow("Secrets");
	});
	test("a rule that wrapped stops the build", () => {
		expect(() =>
			excerptRules(
				source.replace("- Smallest change that works.", "- Smallest change that works.\n  It wraps here."),
				spec,
			),
		).toThrow("two lines");
	});
	test("a section that doubled stops the build", () => {
		expect(() => excerptRules(`${source}\n## Secrets\n- again\n`, spec)).toThrow("appears twice");
	});
	test("a rule that doubled stops the build", () => {
		expect(() =>
			excerptRules(
				source.replace("- Smallest change that works.", "- Smallest change that works.\n- Smallest change again."),
				spec,
			),
		).toThrow("found 2");
	});
});

describe("table selectors", () => {
	test("keep the header and separator and the chosen rows, under a heading of their own", () => {
		expect(excerptRules(host, [{ table: "Deltas", rows: ["| `timeout`", "| Shell"], as: "On this host" }])).toBe(
			[
				"## On this host",
				"",
				"| Rule | Here |",
				"|---|---|",
				"| `timeout` | Use the GNU one. |",
				"| Shell idioms | zsh, not bash. |",
			].join("\n"),
		);
	});
	test("whole keeps every row, and the text around the table is left out", () => {
		const out = excerptRules(host, [{ table: "Deltas", rows: "whole" }]);
		expect(out).toStartWith("## Deltas\n\n| Rule | Here |\n|---|---|");
		expect(out).toContain("Builder-only row");
		expect(out).not.toContain("Where this host differs");
		expect(out).not.toContain("Not wanted");
	});
	test("an aligned separator is a separator", () => {
		expect(
			excerptRules(host.replace("|---|---|", "| :--- | ---: |"), [{ table: "Deltas", rows: ["| Shell"] }]),
		).toContain("| :--- | ---: |");
	});
	test("a row that moved or doubled stops the build", () => {
		expect(() =>
			excerptRules(host.replace("| Shell idioms", "| Shells"), [{ table: "Deltas", rows: ["| Shell idioms"] }]),
		).toThrow("found 0");
		expect(() =>
			excerptRules(
				host.replace("| Shell idioms | zsh, not bash. |", "| Shell idioms | zsh. |\n| Shell idioms | bash. |"),
				[{ table: "Deltas", rows: ["| Shell"] }],
			),
		).toThrow("found 2");
	});
	test("a table that is gone, lost its header or has a second table beside it stops the build", () => {
		expect(() => excerptRules(host.replace(/\|.*\|\n/g, ""), [{ table: "Deltas", rows: "whole" }])).toThrow(
			"no longer holds a table",
		);
		expect(() => excerptRules(host.replace("|---|---|\n", ""), [{ table: "Deltas", rows: "whole" }])).toThrow("header");
		expect(() =>
			excerptRules(host.replace("| Builder-only row", "\n| Builder-only row"), [{ table: "Deltas", rows: "whole" }]),
		).toThrow("2 tables");
		expect(() => excerptRules(host, [{ table: "Gone", rows: "whole" }])).toThrow('"Gone" is gone');
	});
	test("the object form of a section selector renames it", () => {
		expect(excerptRules(source, [{ section: "Secrets", lines: ["- Never"], as: "Keys" }])).toBe(
			"## Keys\n\n- Never paste or echo a secret.",
		);
	});
});

describe("operating-rules.json", () => {
	test('a source may ask for the whole file with "sections": "whole", and only that string', () => {
		expect(parseRulesConfig({ sources: [{ path: "~/x.md", sections: "whole" }] })).toEqual({
			schemaVersion: 2,
			sources: [{ path: "~/x.md", sections: "whole" }],
		});
		expect(() => parseRulesConfig({ sources: [{ path: "~/x.md", sections: "all" }] })).toThrow('must be "whole"');
	});
	test("the single-source form parses as one source, and is stamped", () =>
		expect(parseRulesConfig({ source: "~/x.md", sections: [["A", "whole"]] })).toEqual({
			schemaVersion: 2,
			sources: [{ path: "~/x.md", sections: [["A", "whole"]] }],
		}));
	test("several sources, the object and table selectors and an intro parse", () => {
		const raw = {
			intro: " Read the files for the rest. ",
			sources: [
				{ path: "~/shared.md", sections: [["A", "whole"], { section: "B", lines: ["- x"], as: "Bee" }] },
				{
					path: "~/host.md",
					sections: [
						{ table: "Deltas", rows: ["| a"], as: "On this host" },
						{ table: "T", rows: "whole" },
					],
				},
			],
		};
		expect(parseRulesConfig(raw)).toEqual({
			schemaVersion: 2,
			intro: "Read the files for the rest.",
			sources: [
				{ path: "~/shared.md", sections: [["A", "whole"], { section: "B", lines: ["- x"], as: "Bee" }] },
				{
					path: "~/host.md",
					sections: [
						{ table: "Deltas", rows: ["| a"], as: "On this host" },
						{ table: "T", rows: "whole" },
					],
				},
			],
		});
	});
	test("the shipped example parses", () => {
		const c = parseRulesConfig(
			JSON.parse(readFileSync(new URL("../../../examples/operating-rules.json", import.meta.url), "utf8")),
		);
		expect(c.sources.length).toBe(2);
		expect(c.sources[0]!.sections[0]).toEqual({
			table: "Deltas",
			rows: ["| `timeout`", "| Shell idioms"],
			as: "On this host",
		});
	});
	test("refuses a malformed multi-source config", () => {
		expect(() => parseRulesConfig({ sources: [] })).toThrow("at least one");
		expect(() => parseRulesConfig({ sources: [{ sections: [["A", "whole"]] }] })).toThrow("source 1 needs the path");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [] }] })).toThrow("sections");
		expect(() =>
			parseRulesConfig({
				source: "x",
				sections: [["A", "whole"]],
				sources: [{ path: "y", sections: [["A", "whole"]] }],
			}),
		).toThrow("not both");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ table: "T" }] }] })).toThrow('"rows"');
		expect(() =>
			parseRulesConfig({ sources: [{ path: "x", sections: [{ table: "T", section: "S", rows: "whole" }] }] }),
		).toThrow("exactly one");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ section: "S", lines: [] }] }] })).toThrow(
			'"lines"',
		);
		expect(() =>
			parseRulesConfig({ sources: [{ path: "x", sections: [{ section: "S", lines: "whole", as: "" }] }] }),
		).toThrow('"as"');
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: ["S"] }] })).toThrow("must be");
		expect(() => parseRulesConfig({ intro: 3, sources: [{ path: "x", sections: [["A", "whole"]] }] })).toThrow("intro");
	});
	test("names the selector form and the heading that is wrong", () => {
		const bad = (sections: unknown[]) => () => parseRulesConfig({ sources: [{ path: "x", sections }] });
		expect(bad([["", "whole"]])).toThrow("source 1 section 1 needs a heading");
		expect(
			bad([
				["A", "whole"],
				[3, "whole"],
			]),
		).toThrow("source 1 section 2 needs a heading");
		expect(bad([{ table: "", rows: "whole" }])).toThrow('section 1: "table" must be the heading the table sits under');
		expect(bad([{ table: "T", rows: [] }])).toThrow('table "T" needs "rows": "whole" or a list of row prefixes');
		expect(bad([{ section: "", lines: "whole" }])).toThrow('section 1: "section" must be a heading');
		expect(bad([{ section: "S", lines: [""] }])).toThrow(
			'section "S" needs "lines": "whole" or a list of line prefixes',
		);
		expect(
			bad([
				{ section: "S", lines: "whole" },
				{ section: "S", as: 3 },
			]),
		).toThrow('section 2: "as" must be a heading');
		expect(bad([null])).toThrow("section 1 must be [heading");
	});
	test("refuses a malformed or newer config", () => {
		expect(() => parseRulesConfig({ source: "x" })).toThrow("sections");
		expect(() => parseRulesConfig({ source: "x", sections: [["A", []]] })).toThrow('needs "whole"');
		expect(() => parseRulesConfig({ schemaVersion: 7, source: "x", sections: [["A", "whole"]] })).toThrow(
			"newer Chamberlain",
		);
	});
});
