import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { excerptRules, loadOperatingRules, parseRulesConfig, type RuleSpec } from "./rules.ts";

const source = `# Operating rules

## Secrets
- Never paste or echo a secret.
- Enter secrets only in their own thread.

## Working style
- Whole issue: finish a piece before starting the next.
- Smallest change that works.
- Builder-only note nobody else needs.

## Builders
- Use the fast lane for builds.
`;
const spec: RuleSpec[] = [
	["Secrets", "whole"],
	["Working style", ["- Whole issue", "- Smallest change"]],
];

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

const host = `# This host

## Deltas
Where this host differs from the shared rules.

| Rule | Here |
|---|---|
| \`timeout\` | Use the GNU one. |
| Shell idioms | zsh, not bash. |
| Builder-only row | Nobody else needs it. |

## Other
- Not wanted.
`;

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
			JSON.parse(readFileSync(new URL("../../examples/operating-rules.json", import.meta.url), "utf8")),
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
