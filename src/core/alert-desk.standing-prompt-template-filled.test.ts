/** alert-desk, continued: see alert-desk.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULTS, parseConfig, systemTimezone } from "./alert-desk-config.ts";
import {
	morningPattern,
	parseMorning,
	parseOperator,
	readMorning,
	readOperator,
	renderDeskPrompt,
} from "./alert-desk-prompt.ts";

describe("the standing prompt is a template, filled from config", () => {
	const template = readFileSync(new URL("../../docs/alert-desk-prompt.md", import.meta.url), "utf8");
	const vars = {
		principalName: "Ada",
		serverName: "box-1",
		allowlistHook: "bun /opt/chamberlain/src/desk-allowlist.ts hook",
		askCommand: "bun /opt/chamberlain/src/ask.ts",
		morning: { commands: ["bun /opt/monitor/report.ts list --limit <N> --json"], notes: "Skip source monitor." },
	};
	test("the bundled prompt names nobody and no host: who it works for and where are placeholders", () => {
		for (const v of [
			"{{principalName}}",
			"{{serverName}}",
			"{{allowlistHook}}",
			"{{askCommand}}",
			"{{morningSources}}",
			"{{gatherStep}}",
			"{{toolList}}",
			"{{operatorCommands}}",
		])
			expect(template).toContain(v);
		expect(template).not.toMatch(/\.claude\//);
	});
	test("the bundled prompt names no model and no private wrapper: those are the operator's, from alert-desk.json", () => {
		expect(template).not.toMatch(/\b(sonnet|haiku|opus)\b/i);
	});
	test("the desk is told not to re-ask what is settled, when a question can wait, and when notSettled is allowed", () => {
		const out = renderDeskPrompt(template, vars);
		expect(out).toContain('Add `"urgent": false` when it can wait');
		expect(out).toContain(
			"If ask refuses because the matter is already settled (exit 2, with the earlier answer and what it matched on printed), do not re-ask.",
		);
		expect(out).toContain('Use `"notSettled": "<what is new>"` only when something materially new happened');
	});
	test("rendered, every placeholder is filled from the config, and the morning sources are listed", () => {
		const out = renderDeskPrompt(template, vars);
		expect(out).not.toMatch(
			/\{\{(principalName|serverName|allowlistHook|askCommand|morningSources|gatherStep|toolList|operatorCommands)\}\}/,
		);
		expect(out).not.toContain("<!--");
		expect(out).toContain("every alert Ada's systems raise");
		expect(out).toContain('"server":"box-1"');
		expect(out).toContain("bun /opt/chamberlain/src/ask.ts '{");
		expect(out).toContain("`bun /opt/chamberlain/src/desk-allowlist.ts hook` (Chamberlain's desk allowlist)");
		expect(out).toContain("   - `bun /opt/monitor/report.ts list --limit <N> --json`");
		expect(out).toContain("   Skip source monitor.");
		// docker's own {{.Field}} templates are left alone.
		expect(out).toContain("{{.State.Status}}");
	});
	test("with no morning sources the prompt says none are configured", () => {
		expect(renderDeskPrompt(template, { ...vars, morning: { commands: [] } })).toContain(
			"No morning sources are configured",
		);
	});
	test("morning sources parse from alert-desk.json, and anything malformed is left out", () => {
		expect(parseMorning({ morningCommands: ["a <N>", "", 3, "two\nlines"], morningNotes: " n " })).toEqual({
			commands: ["a <N>"],
			notes: "n",
		});
		expect(parseMorning({})).toEqual({ commands: [] });
		expect(morningPattern("x --limit <N> 'a.b'").test("x --limit 12 'a.b'")).toBe(true);
		expect(morningPattern("x --limit <N> 'a.b'").test("x --limit 12 'aXb'")).toBe(false);
	});
	test("a slot may give its width: <N:a-b> is a to b digits, <N:a> exactly a; plain <N> is still 1 to 12", () => {
		const p = morningPattern("x --limit <N:1-5> --since <N:10> --page <N>");
		expect(p.test("x --limit 12345 --since 1700000000 --page 7")).toBe(true);
		expect(p.test("x --limit 1 --since 1700000000 --page 123456789012")).toBe(true);
		expect(p.test("x --limit 123456 --since 1700000000 --page 7")).toBe(false);
		expect(p.test("x --limit 12 --since 170000000 --page 7")).toBe(false);
		expect(p.test("x --limit 12 --since 17000000000 --page 7")).toBe(false);
		expect(p.test("x --limit 12 --since 1700000000 --page 1234567890123")).toBe(false);
		expect(p.test("x --limit  --since 1700000000 --page 7")).toBe(false);
		expect(morningPattern("x <N>").test("x 123456789012")).toBe(true);
		expect(morningPattern("x <N>").test("x 1234567890123")).toBe(false);
		expect(morningPattern("x <N:3-3> 'a.b'").test("x 123 'aXb'")).toBe(false);
	});
	test("a malformed width leaves the command out with a warning, and its pattern matches nothing", () => {
		for (const bad of ["x <N:0-3>", "x <N:5-2>", "x <N:1-13>", "x <N:a-b>", "x <N:>", "x <N:1-5"]) {
			const warned: string[] = [];
			expect(parseMorning({ morningCommands: [bad, "ok <N:1-5>"] }, (m) => warned.push(m)).commands).toEqual([
				"ok <N:1-5>",
			]);
			expect(warned).toHaveLength(1);
			expect(warned[0]).toContain(bad);
			expect(morningPattern(bad).test(bad)).toBe(false);
			expect(morningPattern(bad).test("x 1")).toBe(false);
		}
	});
	test("they are read only from an alert-desk.json the operator owns that no one else can write", () => {
		const conf = mkdtempSync(`${tmpdir()}/desk-morning-`);
		writeFileSync(`${conf}/alert-desk.json`, JSON.stringify({ morningCommands: ["a <N>"] }));
		chmodSync(`${conf}/alert-desk.json`, 0o644);
		expect(readMorning(conf).commands).toEqual(["a <N>"]);
		chmodSync(`${conf}/alert-desk.json`, 0o664);
		const warned: string[] = [];
		expect(readMorning(conf, (m) => warned.push(m)).commands).toEqual([]);
		expect(warned[0]).toContain("group-writable");
		expect(readMorning(mkdtempSync(`${tmpdir()}/desk-none-`), (m) => warned.push(m))).toEqual({ commands: [] });
		expect(warned).toHaveLength(1);
	});
});

describe("the operator's own command shapes and gatherer", () => {
	const template = readFileSync(new URL("../../docs/alert-desk-prompt.md", import.meta.url), "utf8");
	const base = {
		principalName: "Ada",
		serverName: "box-1",
		allowlistHook: "chamberlain debug desk-allowlist hook",
		askCommand: "chamberlain ask",
		morning: { commands: [] },
	};
	const shapes = parseOperator({
		commandShapes: {
			opsctl: {
				bare: true,
				subcommands: {
					health: { positional: "word", max: 1 },
					journal: { flags: { "--limit": "digits" }, positional: "word", min: 1, max: 1 },
				},
			},
		},
	}).shapes;

	test("with no gatherer the prompt tells the desk to read the evidence itself and lists no Agent tool", () => {
		const out = renderDeskPrompt(template, base);
		expect(out).toContain("No gatherer agent is configured, so read the evidence yourself");
		expect(out).toContain("the only tools you have are Bash (in these shapes), Read, Grep and Glob;");
		expect(out).not.toContain("subagent_type");
	});
	test("with a gatherer the prompt names it in the evidence step and in the tool list", () => {
		const out = renderDeskPrompt(template, { ...base, gatherer: "evidence-reader" });
		expect(out).toContain(
			'Fan out at most 4 `evidence-reader` subagents for the family (Agent tool, `subagent_type: "evidence-reader"`)',
		);
		expect(out).toContain("the Agent tool for `evidence-reader` gatherers;");
	});
	test("the operator's shapes are bullets in the list of what may run, and with none the list has no gap", () => {
		const out = renderDeskPrompt(template, { ...base, shapes });
		expect(out).toContain(
			"- `opsctl`, `opsctl health [<word>]`, `opsctl journal [--limit <digits>] <word>`.\n- Reads with the Read, Grep and Glob tools",
		);
		const none = renderDeskPrompt(template, base);
		expect(none).not.toContain("opsctl");
		expect(none).toContain("`docker inspect --format");
		expect(none).not.toMatch(/\n\n- Reads with/);
		expect(none).toContain("or `Config.Env`.\n- Reads with the Read, Grep and Glob tools");
	});
	test("a value with a `$` in it is not a replacement pattern", () => {
		expect(renderDeskPrompt(template, { ...base, gatherer: "a$&b" })).toContain("`a$&b`");
	});
	test("they parse from alert-desk.json, and a malformed shape or gatherer is left out whole, with a warning", () => {
		const warned: string[] = [];
		const o = parseOperator(
			{
				gatherer: "bad name!",
				commandShapes: {
					good: { subcommands: { status: { max: 0 } } },
					bad: { subcommands: { "Run View": {} } },
					docker: { max: 5 },
					"a/b": {},
					worse: { flags: { x: "bool" } },
					kind: { positional: "anything" },
				},
			},
			(m) => warned.push(m),
		);
		expect(Object.keys(o.shapes)).toEqual(["good"]);
		expect(o.gatherer).toBeUndefined();
		expect(warned).toHaveLength(6);
		expect(parseOperator({ gatherer: "evidence-reader" }).gatherer).toBe("evidence-reader");
	});
	test("they are read only from an alert-desk.json the operator owns that no one else can write", () => {
		const conf = mkdtempSync(`${tmpdir()}/desk-operator-`);
		writeFileSync(
			`${conf}/alert-desk.json`,
			JSON.stringify({ gatherer: "evidence-reader", commandShapes: { opsctl: { bare: true } } }),
		);
		chmodSync(`${conf}/alert-desk.json`, 0o600);
		expect(readOperator(conf).gatherer).toBe("evidence-reader");
		expect(Object.keys(readOperator(conf).shapes)).toEqual(["opsctl"]);
		chmodSync(`${conf}/alert-desk.json`, 0o666);
		const warned: string[] = [];
		const o = readOperator(conf, (m) => warned.push(m));
		expect(o).toEqual({ morning: { commands: [] }, shapes: {} });
		expect(warned[0]).toContain("writable");
	});
});

describe("the morning time zone", () => {
	test("defaults to the machine's own zone, not a place", () => {
		expect(DEFAULTS.timezone).toBe(systemTimezone());
		expect(parseConfig({}).timezone).toBe(systemTimezone());
		expect(parseConfig({ timezone: "Asia/Tokyo" }).timezone).toBe("Asia/Tokyo");
		expect(systemTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});
});
