import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

describe("operating-rules.json", () => {
	test("parses and is stamped", () => expect(parseRulesConfig({ source: "~/x.md", sections: [["A", "whole"]] })).toEqual({ schemaVersion: 2, source: "~/x.md", sections: [["A", "whole"]] }));
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
	test("a world-readable rules config is refused", () => {
		const d = dir();
		writeFileSync(`${d}/operating-rules.md`, "x", { mode: 0o644 });
		expect(() => loadOperatingRules(d)).toThrow("0600");
	});
});
