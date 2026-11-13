/**
 * The part of your operating rules a Steward acts on. The lines are lifted from your own markdown files at build time, so
 * there is no second copy to drift, and a line that moved stops the build instead of quietly dropping a rule.
 *
 * `operating-rules.json` in the config directory (mode 0600) lists one or more source files, each with the parts to take:
 *
 *   { "schemaVersion": 2,
 *     "intro": "The rest of these files is for builders. Read them when a rule seems missing.",
 *     "sources": [
 *       { "path": "~/notes/OPERATING_RULES.md",
 *         "sections": [ ["Secrets", "whole"], ["Working style", ["- Whole issue", "- Smallest change"]] ] },
 *       { "path": "~/notes/hosts/this-host.md",
 *         "sections": [ { "table": "Deltas", "rows": ["| `timeout`", "| Shell"], "as": "On this host" } ] } ] }
 *
 * A selector is one of:
 *   - `[heading, "whole" | [line prefixes]]`: the `## heading` section of the source, every line or the lines that start
 *     with each prefix (the form 0.1 had);
 *   - `{ "section": heading, "lines": "whole" | [prefixes], "as"?: heading }`: the same, written as an object, with `as`
 *     to give the excerpt a heading of its own;
 *   - `{ "table": heading, "rows": "whole" | [row prefixes], "as"?: heading }`: the one markdown table under `## heading`,
 *     its header row and separator always kept, and every body row or the rows that start with each prefix.
 * The excerpts come out in the order listed, sources first to last, after `intro` when there is one.
 *
 * A heading that is gone or appears twice, a prefix that matches no line or several, a rule that has wrapped onto a
 * second line, and a table that is missing, has lost its header or is not alone under its heading all throw. A source whose
 * excerpt throws is copied whole, and the others are still excerpted.
 *
 * The single-source form `{ "source": path, "sections": [...] }` is still read, as one entry of `sources`. Without the
 * file, brief.ts uses `operating-rules.md` from the config directory whole, if there is one.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isPrivateFile, modeText } from "./private.ts";
import { SCHEMA_VERSION, checkVersion } from "./schema.ts";

/** The 0.1 selector: a section, whole or by line prefixes. */
export type RuleSpec = [section: string, lines: string[] | "whole"];
/** A section of the source, whole or by line prefixes, optionally under a heading of its own. */
export type SectionSelector = { section: string; lines: string[] | "whole"; as?: string };
/** The one markdown table under a section's heading: its header and separator, and every body row or the rows chosen by prefix. */
export type TableSelector = { table: string; rows: string[] | "whole"; as?: string };
export type Selector = RuleSpec | SectionSelector | TableSelector;
export type RulesSource = { path: string; sections: Selector[] };
export type RulesConfig = { schemaVersion?: number; intro?: string; sources: RulesSource[] };

/** The lines under `## name`, up to the next `## ` heading. Blank lines are dropped unless `keepBlank` (a table needs them to tell two tables apart). */
const sectionLines = (text: string, name: string, keepBlank = false): string[] => {
	const lines = text.split("\n");
	const start = lines.indexOf(`## ${name}`);
	if (start < 0) throw Error(`operating rules: section "${name}" is gone from the source`);
	if (lines.lastIndexOf(`## ${name}`) !== start) throw Error(`operating rules: section "${name}" appears twice`);
	const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
	const body = lines.slice(start + 1, end < 0 ? lines.length : end);
	return keepBlank ? body : body.filter((l) => l.trim());
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

const TABLE_ROW = /^\s*\|/;
const SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

/** The one table in a section's lines: its header, its separator and its body rows. Throws when there is none, or several, or no header. */
const tableLines = (lines: string[], name: string): { header: string[]; body: string[] } => {
	const runs: string[][] = [];
	let prev = false;
	for (const l of lines) {
		const row = TABLE_ROW.test(l);
		if (row && !prev) runs.push([]);
		if (row) runs[runs.length - 1]!.push(l);
		prev = row;
	}
	if (runs.length === 0) throw Error(`operating rules: section "${name}" no longer holds a table`);
	if (runs.length > 1) throw Error(`operating rules: section "${name}" now holds ${runs.length} tables, so which one is meant is unclear`);
	const [table] = runs as [string[]];
	if (table.length < 2 || !SEPARATOR.test(table[1]!)) throw Error(`operating rules: the table in "${name}" no longer starts with its header`);
	return { header: table.slice(0, 2), body: table.slice(2) };
};

const pickRow = (rows: string[], prefix: string, where: string): string => {
	const hits = rows.filter((l) => l.startsWith(prefix));
	if (hits.length !== 1) throw Error(`operating rules: expected one row starting "${prefix}" in the table in ${where}, found ${hits.length}`);
	return hits[0] as string;
};

/** Every selector in its object form. */
const normalize = (s: Selector): SectionSelector | TableSelector => (Array.isArray(s) ? { section: s[0], lines: s[1] } : s);

/** Pure: one selector's excerpt of `source` as markdown. Throws if a chosen heading, line or row has moved. */
function excerptOne(source: string, selector: Selector): string {
	const s = normalize(selector);
	if ("table" in s) {
		const { header, body } = tableLines(sectionLines(source, s.table, true), s.table);
		const rows = s.rows === "whole" ? body : s.rows.map((p) => pickRow(body, p, `"${s.table}"`));
		return [`## ${s.as ?? s.table}`, "", ...header, ...rows].join("\n");
	}
	const lines = sectionLines(source, s.section);
	return [`## ${s.as ?? s.section}`, "", ...(s.lines === "whole" ? lines : s.lines.map((p) => pick(lines, p, s.section)))].join("\n");
}

/** Pure: the chosen sections of `source` as markdown, in the order given. Throws if a chosen heading, line or row has moved. */
export function excerptRules(source: string, sections: Selector[]): string {
	return sections.map((s) => excerptOne(source, s)).join("\n\n");
}

const WANTED = (x: unknown): x is string[] | "whole" => x === "whole" || (Array.isArray(x) && x.length > 0 && x.every((y) => typeof y === "string" && y.length > 0));

function parseSelector(raw: unknown, where: string, i: number): Selector {
	if (Array.isArray(raw)) {
		const [name, wanted] = raw as [unknown, unknown];
		if (typeof name !== "string" || !name) throw Error(`operating-rules.json: ${where} section ${i + 1} needs a heading`);
		if (!WANTED(wanted)) throw Error(`operating-rules.json: ${where} section "${name}" needs "whole" or a list of line prefixes`);
		return [name, wanted];
	}
	if (!raw || typeof raw !== "object") throw Error(`operating-rules.json: ${where} section ${i + 1} must be [heading, "whole" | [line prefixes]] or an object with "section" or "table"`);
	const o = raw as { section?: unknown; lines?: unknown; table?: unknown; rows?: unknown; as?: unknown };
	if (o.as !== undefined && (typeof o.as !== "string" || !o.as.trim())) throw Error(`operating-rules.json: ${where} section ${i + 1}: "as" must be a heading`);
	const as = typeof o.as === "string" ? { as: o.as.trim() } : {};
	if ((o.section === undefined) === (o.table === undefined)) throw Error(`operating-rules.json: ${where} section ${i + 1} needs exactly one of "section" and "table"`);
	if (o.table !== undefined) {
		if (typeof o.table !== "string" || !o.table) throw Error(`operating-rules.json: ${where} section ${i + 1}: "table" must be the heading the table sits under`);
		if (!WANTED(o.rows)) throw Error(`operating-rules.json: ${where} table "${o.table}" needs "rows": "whole" or a list of row prefixes`);
		return { table: o.table, rows: o.rows, ...as };
	}
	if (typeof o.section !== "string" || !o.section) throw Error(`operating-rules.json: ${where} section ${i + 1}: "section" must be a heading`);
	if (!WANTED(o.lines)) throw Error(`operating-rules.json: ${where} section "${o.section}" needs "lines": "whole" or a list of line prefixes`);
	return { section: o.section, lines: o.lines, ...as };
}

function parseSource(path: unknown, sections: unknown, where: string): RulesSource {
	if (typeof path !== "string" || !path.trim()) throw Error(`operating-rules.json: ${where} needs the path of a markdown file`);
	if (!Array.isArray(sections) || !sections.length) throw Error(`operating-rules.json: ${where} "sections" must list at least one [heading, "whole" | [line prefixes]] or table`);
	return { path: path.trim(), sections: sections.map((s, i) => parseSelector(s, where, i)) };
}

/** Pure: a parsed operating-rules.json, the single-source form read as one entry of `sources`. */
export function parseRulesConfig(raw: unknown): RulesConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("operating-rules.json: expected a JSON object");
	const o = raw as { schemaVersion?: unknown; intro?: unknown; source?: unknown; sections?: unknown; sources?: unknown };
	checkVersion("operating-rules.json", o.schemaVersion);
	if (o.intro !== undefined && typeof o.intro !== "string") throw Error('operating-rules.json: "intro" must be text');
	const intro = typeof o.intro === "string" && o.intro.trim() ? { intro: o.intro.trim() } : {};
	if (o.sources !== undefined) {
		if (o.source !== undefined || o.sections !== undefined) throw Error('operating-rules.json: use "sources", or "source" with "sections", not both');
		if (!Array.isArray(o.sources) || !o.sources.length) throw Error('operating-rules.json: "sources" must list at least one { "path", "sections" }');
		const sources = o.sources.map((x, i) => {
			if (!x || typeof x !== "object" || Array.isArray(x)) throw Error(`operating-rules.json: source ${i + 1} must be { "path", "sections" }`);
			const s = x as { path?: unknown; sections?: unknown };
			return parseSource(s.path, s.sections, `source ${i + 1}`);
		});
		return { schemaVersion: SCHEMA_VERSION, ...intro, sources };
	}
	if (typeof o.source !== "string" || !o.source.trim()) throw Error('operating-rules.json: "source" must be the path of a markdown file (or use "sources")');
	return { schemaVersion: SCHEMA_VERSION, ...intro, sources: [parseSource(o.source, o.sections, "source")] };
}

const tilde = (p: string) => p.replace(/^~(?=\/)/, process.env.HOME ?? "~");
const regular = (p: string, what: string) => {
	const st = statSync(p);
	if (!isPrivateFile(st)) throw Error(`${what} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
};

/**
 * The operating-rules text for the hand-off, or "" when none is configured. A source whose excerpt fails (a rule moved)
 * is copied whole instead, and says so on stderr: a hand-off must always come out, and the whole file loses nothing.
 */
export function loadOperatingRules(conf: string, warn: (msg: string) => void = (m) => console.error(m)): string {
	const cfg = `${conf}/operating-rules.json`;
	if (existsSync(cfg)) {
		regular(cfg, "operating-rules.json");
		const c = parseRulesConfig(JSON.parse(readFileSync(cfg, "utf8")));
		const parts = c.sources.map((src) => {
			const text = readFileSync(tilde(src.path), "utf8");
			try {
				return excerptRules(text, src.sections);
			} catch (e) {
				warn(`brief.ts: copying the rules whole from ${src.path}. ${(e as Error).message}`);
				return text.trimEnd();
			}
		});
		return [...(c.intro ? [c.intro] : []), ...parts].join("\n\n");
	}
	const md = `${conf}/operating-rules.md`;
	if (existsSync(md)) { regular(md, "operating-rules.md"); return readFileSync(md, "utf8"); }
	return "";
}
