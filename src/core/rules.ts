/**
 * The part of your operating rules a Steward acts on. The lines are lifted from your own markdown file at build time, so
 * there is no second copy to drift, and a line that moved stops the build instead of quietly dropping a rule.
 *
 * `operating-rules.json` in the config directory (mode 0600):
 *
 *   { "schemaVersion": 1,
 *     "source": "~/notes/OPERATING_RULES.md",
 *     "sections": [ ["Secrets", "whole"], ["Working style", ["- Whole issue", "- Smallest change"]] ] }
 *
 * Each entry names a `## Heading` of the source and either "whole" (every line of the section) or the line prefixes to
 * keep. A heading that is gone or appears twice, a prefix that matches no line or several, and a rule that has wrapped
 * onto a second line all throw. Without the file, brief.ts uses `operating-rules.md` from the config directory whole, if
 * there is one.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isPrivateFile, modeText } from "./private.ts";
import { SCHEMA_VERSION, checkVersion } from "./schema.ts";

export type RuleSpec = [section: string, lines: string[] | "whole"];
export type RulesConfig = { schemaVersion?: number; source: string; sections: RuleSpec[] };

const sectionLines = (text: string, name: string): string[] => {
	const lines = text.split("\n");
	const start = lines.indexOf(`## ${name}`);
	if (start < 0) throw Error(`operating rules: section "${name}" is gone from the source`);
	if (lines.lastIndexOf(`## ${name}`) !== start) throw Error(`operating rules: section "${name}" appears twice`);
	const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
	return lines.slice(start + 1, end < 0 ? lines.length : end).filter((l) => l.trim());
};

const pick = (lines: string[], prefix: string, where: string): string => {
	const hits = lines.filter((l) => l.startsWith(prefix));
	if (hits.length !== 1) throw Error(`operating rules: expected one line starting "${prefix}" in ${where}, found ${hits.length}`);
	const line = hits[0] as string;
	// Rules are one line each. A rule that wrapped would come through cut in half.
	const next = lines[lines.indexOf(line) + 1];
	if (next !== undefined && !/^(- |\|)/.test(next)) throw Error(`operating rules: the line starting "${prefix}" in ${where} now runs over two lines`);
	return line;
};

/** Pure: the chosen sections of `source` as markdown. Throws if a chosen heading or line has moved. */
export function excerptRules(source: string, sections: RuleSpec[]): string {
	return sections.map(([name, wanted]) => {
		const lines = sectionLines(source, name);
		return [`## ${name}`, "", ...(wanted === "whole" ? lines : wanted.map((p) => pick(lines, p, name)))].join("\n");
	}).join("\n\n");
}

/** Pure: a parsed operating-rules.json. */
export function parseRulesConfig(raw: unknown): RulesConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("operating-rules.json: expected a JSON object");
	const o = raw as { schemaVersion?: unknown; source?: unknown; sections?: unknown };
	checkVersion("operating-rules.json", o.schemaVersion);
	if (typeof o.source !== "string" || !o.source.trim()) throw Error('operating-rules.json: "source" must be the path of a markdown file');
	if (!Array.isArray(o.sections) || !o.sections.length) throw Error('operating-rules.json: "sections" must list at least one [heading, "whole" | [line prefixes]]');
	const sections = o.sections.map((s, i): RuleSpec => {
		const [name, wanted] = s as [unknown, unknown];
		if (typeof name !== "string" || !name) throw Error(`operating-rules.json: section ${i + 1} needs a heading`);
		if (wanted !== "whole" && !(Array.isArray(wanted) && wanted.length && wanted.every((x) => typeof x === "string" && x))) throw Error(`operating-rules.json: section "${name}" needs "whole" or a list of line prefixes`);
		return [name, wanted as RuleSpec[1]];
	});
	return { schemaVersion: SCHEMA_VERSION, source: o.source.trim(), sections };
}

const tilde = (p: string) => p.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const regular = (p: string, what: string) => {
	const st = statSync(p);
	if (!isPrivateFile(st)) throw Error(`${what} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
};

/**
 * The operating-rules text for the hand-off, or "" when none is configured. A failed excerpt (a rule moved) falls back
 * to the source file whole, and says so on stderr: a hand-off must always come out, and the whole file loses nothing.
 */
export function loadOperatingRules(conf: string, warn: (msg: string) => void = (m) => console.error(m)): string {
	const cfg = `${conf}/operating-rules.json`;
	if (existsSync(cfg)) {
		regular(cfg, "operating-rules.json");
		const c = parseRulesConfig(JSON.parse(readFileSync(cfg, "utf8")));
		const source = readFileSync(tilde(c.source), "utf8");
		try {
			return excerptRules(source, c.sections);
		} catch (e) {
			warn(`brief.ts: copying the rules whole. ${(e as Error).message}`);
			return source;
		}
	}
	const md = `${conf}/operating-rules.md`;
	if (existsSync(md)) { regular(md, "operating-rules.md"); return readFileSync(md, "utf8"); }
	return "";
}
