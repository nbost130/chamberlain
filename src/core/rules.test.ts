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
const spec: RuleSpec[] = [["Secrets", "whole"], ["Working style", ["- Whole issue", "- Smallest change"]]];

describe("excerptRules", () => {
	const out = excerptRules(source, spec);
	test("keeps whole sections and the chosen lines", () => {
		for (const s of ["Never paste or echo a secret", "Enter secrets only", "Whole issue: finish a piece", "Smallest change that works"]) expect(out).toContain(s);
	});
	test("drops what was not chosen", () => {
		for (const s of ["Builder-only note", "fast lane"]) expect(out).not.toContain(s);
	});
	test("a rule that moved stops the build", () => {
		expect(() => excerptRules(source.replace("- Smallest change that works.", "- Keep changes small."), spec)).toThrow("Smallest change");
		expect(() => excerptRules(source.replace("## Secrets", "## Credentials"), spec)).toThrow("Secrets");
	});
	test("a rule that wrapped stops the build", () => {
		expect(() => excerptRules(source.replace("- Smallest change that works.", "- Smallest change that works.\n  It wraps here."), spec)).toThrow("two lines");
	});
	test("a section that doubled stops the build", () => {
		expect(() => excerptRules(`${source}\n## Secrets\n- again\n`, spec)).toThrow("appears twice");
	});
	test("a rule that doubled stops the build", () => {
		expect(() => excerptRules(source.replace("- Smallest change that works.", "- Smallest change that works.\n- Smallest change again."), spec)).toThrow("found 2");
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
			["## On this host", "", "| Rule | Here |", "|---|---|", "| `timeout` | Use the GNU one. |", "| Shell idioms | zsh, not bash. |"].join("\n"));
	});
	test("whole keeps every row, and the text around the table is left out", () => {
		const out = excerptRules(host, [{ table: "Deltas", rows: "whole" }]);
		expect(out).toStartWith("## Deltas\n\n| Rule | Here |\n|---|---|");
		expect(out).toContain("Builder-only row");
		expect(out).not.toContain("Where this host differs");
		expect(out).not.toContain("Not wanted");
	});
	test("an aligned separator is a separator", () => {
		expect(excerptRules(host.replace("|---|---|", "| :--- | ---: |"), [{ table: "Deltas", rows: ["| Shell"] }])).toContain("| :--- | ---: |");
	});
	test("a row that moved or doubled stops the build", () => {
		expect(() => excerptRules(host.replace("| Shell idioms", "| Shells"), [{ table: "Deltas", rows: ["| Shell idioms"] }])).toThrow("found 0");
		expect(() => excerptRules(host.replace("| Shell idioms | zsh, not bash. |", "| Shell idioms | zsh. |\n| Shell idioms | bash. |"), [{ table: "Deltas", rows: ["| Shell"] }])).toThrow("found 2");
	});
	test("a table that is gone, lost its header or has a second table beside it stops the build", () => {
		expect(() => excerptRules(host.replace(/\|.*\|\n/g, ""), [{ table: "Deltas", rows: "whole" }])).toThrow("no longer holds a table");
		expect(() => excerptRules(host.replace("|---|---|\n", ""), [{ table: "Deltas", rows: "whole" }])).toThrow("header");
		expect(() => excerptRules(host.replace("| Builder-only row", "\n| Builder-only row"), [{ table: "Deltas", rows: "whole" }])).toThrow("2 tables");
		expect(() => excerptRules(host, [{ table: "Gone", rows: "whole" }])).toThrow('"Gone" is gone');
	});
	test("the object form of a section selector renames it", () => {
		expect(excerptRules(source, [{ section: "Secrets", lines: ["- Never"], as: "Keys" }])).toBe("## Keys\n\n- Never paste or echo a secret.");
	});
});

describe("operating-rules.json", () => {
	test("the single-source form parses as one source, and is stamped", () => expect(parseRulesConfig({ source: "~/x.md", sections: [["A", "whole"]] })).toEqual({ schemaVersion: 2, sources: [{ path: "~/x.md", sections: [["A", "whole"]] }] }));
	test("several sources, the object and table selectors and an intro parse", () => {
		const raw = { intro: " Read the files for the rest. ", sources: [
			{ path: "~/shared.md", sections: [["A", "whole"], { section: "B", lines: ["- x"], as: "Bee" }] },
			{ path: "~/host.md", sections: [{ table: "Deltas", rows: ["| a"], as: "On this host" }, { table: "T", rows: "whole" }] },
		] };
		expect(parseRulesConfig(raw)).toEqual({ schemaVersion: 2, intro: "Read the files for the rest.", sources: [
			{ path: "~/shared.md", sections: [["A", "whole"], { section: "B", lines: ["- x"], as: "Bee" }] },
			{ path: "~/host.md", sections: [{ table: "Deltas", rows: ["| a"], as: "On this host" }, { table: "T", rows: "whole" }] },
		] });
	});
	test("the shipped example parses", () => {
		const c = parseRulesConfig(JSON.parse(readFileSync(new URL("../../examples/operating-rules.json", import.meta.url), "utf8")));
		expect(c.sources.length).toBe(2);
		expect(c.sources[0]!.sections[0]).toEqual({ table: "Deltas", rows: ["| `timeout`", "| Shell idioms"], as: "On this host" });
	});
	test("refuses a malformed multi-source config", () => {
		expect(() => parseRulesConfig({ sources: [] })).toThrow("at least one");
		expect(() => parseRulesConfig({ sources: [{ sections: [["A", "whole"]] }] })).toThrow("source 1 needs the path");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [] }] })).toThrow("sections");
		expect(() => parseRulesConfig({ source: "x", sections: [["A", "whole"]], sources: [{ path: "y", sections: [["A", "whole"]] }] })).toThrow("not both");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ table: "T" }] }] })).toThrow('"rows"');
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ table: "T", section: "S", rows: "whole" }] }] })).toThrow("exactly one");
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ section: "S", lines: [] }] }] })).toThrow('"lines"');
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: [{ section: "S", lines: "whole", as: "" }] }] })).toThrow('"as"');
		expect(() => parseRulesConfig({ sources: [{ path: "x", sections: ["S"] }] })).toThrow("must be");
		expect(() => parseRulesConfig({ intro: 3, sources: [{ path: "x", sections: [["A", "whole"]] }] })).toThrow("intro");
	});
	test("refuses a malformed or newer config", () => {
		expect(() => parseRulesConfig({ source: "x" })).toThrow("sections");
		expect(() => parseRulesConfig({ source: "x", sections: [["A", []]] })).toThrow('needs "whole"');
		expect(() => parseRulesConfig({ schemaVersion: 7, source: "x", sections: [["A", "whole"]] })).toThrow("newer Chamberlain");
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
	test("a config excerpts its source; a moved rule falls back to the whole file and says so", () => {
		const d = dir();
		writeFileSync(`${d}/source.md`, source, { mode: 0o600 });
		writeFileSync(`${d}/operating-rules.json`, JSON.stringify({ source: `${d}/source.md`, sections: spec }), { mode: 0o600 });
		expect(loadOperatingRules(d)).not.toContain("Builder-only");
		writeFileSync(`${d}/source.md`, source.replace("## Secrets", "## Credentials"), { mode: 0o600 });
		const warned: string[] = [];
		expect(loadOperatingRules(d, (m) => warned.push(m))).toContain("Builder-only");
		expect(warned[0]).toContain("copying the rules whole");
	});
	test("several sources come out in order after the intro; a source that moved is copied whole while the others are still excerpted", () => {
		const d = dir();
		writeFileSync(`${d}/shared.md`, source, { mode: 0o600 });
		writeFileSync(`${d}/host.md`, host, { mode: 0o600 });
		writeFileSync(`${d}/operating-rules.json`, JSON.stringify({ intro: "Read the files for the rest.", sources: [
			{ path: `${d}/host.md`, sections: [{ table: "Deltas", rows: ["| Shell idioms"], as: "On this host" }] },
			{ path: `${d}/shared.md`, sections: spec },
		] }), { mode: 0o600 });
		const out = loadOperatingRules(d);
		expect(out).toStartWith("Read the files for the rest.\n\n## On this host\n\n| Rule | Here |");
		expect(out.indexOf("## On this host")).toBeLessThan(out.indexOf("## Secrets"));
		for (const s of ["Builder-only", "Not wanted", "timeout"]) expect(out).not.toContain(s);
		writeFileSync(`${d}/host.md`, host.replace("| Shell idioms", "| Shells"), { mode: 0o600 });
		const warned: string[] = [];
		const fell = loadOperatingRules(d, (m) => warned.push(m));
		expect(fell).toContain("Builder-only row");
		expect(fell).not.toContain("Builder-only note");
		expect(warned).toEqual([expect.stringContaining(`copying the rules whole from ${d}/host.md`)]);
	});
	test("a world-readable rules config is refused", () => {
		const d = dir();
		writeFileSync(`${d}/operating-rules.md`, "x", { mode: 0o644 });
		expect(() => loadOperatingRules(d)).toThrow("0600");
	});
});
