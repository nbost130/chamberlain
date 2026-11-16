/**
 * The standalone binary's front door: the dispatcher, and the one helper that renders every command an agent or an operator is told to run.
 * The same strings are rendered twice, as the compiled binary would (`chamberlain <sub>`) and from source (`bun <checkout>/src/....ts`).
 * scripts/smoke.ts proves the real compiled binary does the first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t3Brief } from "./adapters/t3/brief.ts";
import { REPO, selfArgv, selfCommand, setCompiled } from "./core/config/config.ts";
import { awayModeLine } from "./core/messages.ts";
import { type BriefInput, stewardBrief } from "./core/steward/brief.ts";
import { renderStartPrompt, type SweepAction, sweepMessage } from "./core/sweep/sweep.ts";

afterEach(() => setCompiled());

describe("selfCommand: one helper renders every command string", () => {
	test("compiled, it is `chamberlain <sub>`; from source, `bun <checkout>/<file>`", () => {
		expect(selfCommand("ask", { compiled: true })).toBe("chamberlain ask");
		expect(selfCommand("afk", { compiled: true })).toBe("chamberlain afk");
		expect(selfCommand("ask", { compiled: false })).toBe(`bun ${REPO}/src/ask.ts`);
		expect(selfCommand("afk", { compiled: false })).toBe(`bun ${REPO}/src/core/ops/afk.ts`);
		expect(selfCommand("peek", { compiled: false, repo: "/opt/chamberlain" })).toBe(
			"bun /opt/chamberlain/src/adapters/t3/peek.ts",
		);
		expect(selfCommand("peek", { compiled: true, repo: "/opt/chamberlain" })).toBe("chamberlain debug peek");
	});
	test("without an override it follows the build: this test runs from source", () => {
		expect(selfCommand("ask")).toBe(`bun ${REPO}/src/ask.ts`);
		setCompiled(true);
		expect(selfCommand("ask")).toBe("chamberlain ask");
		setCompiled();
		expect(selfCommand("ask")).toBe(`bun ${REPO}/src/ask.ts`);
	});
	test("the child process the daemon starts is the binary itself with the subcommand, or this runtime on the source file", () => {
		expect(selfArgv("ask", { compiled: true })).toEqual([process.execPath, "ask"]);
		expect(selfArgv("ask", { compiled: false })).toEqual([process.execPath, `${REPO}/src/ask.ts`]);
		expect(selfArgv("peek", { compiled: true })).toEqual([process.execPath, "debug", "peek"]);
	});
	test("no module builds `bun <path>/src/...` by hand: this helper is the one home", () => {
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
			);
		const offenders = walk(join(REPO, "src"))
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("/core/config/config.ts"))
			.filter(
				(f) =>
					/bun \$\{[^}]*\}\/src\//.test(readFileSync(f, "utf8")) ||
					/new URL\("[^"]*\.ts", import\.meta\.url\)\.pathname\}/.test(readFileSync(f, "utf8")) ||
					/process\.execPath,\s*new URL\(/.test(readFileSync(f, "utf8")),
			);
		expect(offenders).toEqual([]);
	});
});

describe("every prompt-embedded command, rendered both ways", () => {
	const afk = { enteredAt: "2026-11-02T03:46:27Z", words: "keep going" };
	/** Built at call time: the adapter's sentences, like every other, are rendered for the build that is running. */
	const brief = (): BriefInput => ({
		mode: "live",
		repo: "/opt/chamberlain",
		principal: "Ada",
		rights: "r",
		rulings: "x",
		operatingRules: "",
		afk,
		environments: [{ name: "main" }],
		predecessor: undefined,
		notes: t3Brief({ repo: "/opt/chamberlain" }),
	});
	/** A failed check names the missing string, not the whole hand-off. */
	const has = (out: string, s: string) => expect(out.includes(s), `missing: ${s}`).toBe(true);
	const action = { wake: "routine", fresh: [{ key: "check:a", text: "a thing" }] } as unknown as SweepAction;
	const render = () => [stewardBrief(brief()), sweepMessage(action, "BODY"), awayModeLine(afk)].join("\n");

	test("from source they name `bun .../src/....ts`", () => {
		const out = render();
		for (const c of [
			"bun /opt/chamberlain/src/ask.ts '<json>'",
			"bun /opt/chamberlain/src/core/ops/afk.ts hold",
			"bun /opt/chamberlain/src/core/ops/afk.ts held",
			"bun /opt/chamberlain/src/core/ops/decided.ts list 15",
			"bun /opt/chamberlain/src/core/ops/ruling.ts --stated-in-chat",
			"bun /opt/chamberlain/src/adapters/t3/peek.ts <server> <threadId>",
			"bun /opt/chamberlain/src/adapters/t3/t3x.ts threads|read|respond|send <server>",
		])
			has(out, c);
		// The sweep wake and the away mandate are built without a repo argument: they name this checkout.
		has(out, `bun ${REPO}/src/ask.ts '<json>'`);
		has(out, `bun ${REPO}/src/core/ops/afk.ts hold ... --item`);
		expect(out.includes("chamberlain ask")).toBe(false);
	});
	test("compiled they name `chamberlain <sub>`, and no checkout path is left in any of them", () => {
		setCompiled(true);
		const out = render();
		for (const c of [
			"chamberlain ask '<json>'",
			"chamberlain afk hold",
			"chamberlain afk held",
			"chamberlain afk status",
			"chamberlain afk note",
			"chamberlain afk close ",
			"chamberlain decided list 15",
			"chamberlain ruling --stated-in-chat",
			"chamberlain debug peek <server> <threadId>",
			"chamberlain debug t3x threads|read|respond|send <server>",
		])
			has(out, c);
		expect(out.match(/\bbun \S*\/src\/\S*/g)).toBeNull();
		expect(out.includes("/opt/chamberlain")).toBe(false);
		expect(out.includes(REPO)).toBe(false);
	});
});

describe("the new Steward's first message names commands that exist in the build running it", () => {
	const template = readFileSync(join(REPO, "docs/steward-start.md"), "utf8");
	test("the template hard-codes no checkout command and no home path", () => {
		expect(template).not.toMatch(/bun src\/|~\/\.config|~\/\.local/);
		for (const v of ["{{briefSteward}}", "{{briefWake}}", "{{switchSteward}}", "{{conf}}"])
			expect(template).toContain(v);
	});
	test("compiled, it says `chamberlain <subcommand>`, and no placeholder is left", () => {
		const out = renderStartPrompt(template, { conf: "/home/u/.config/chamberlain", compiled: true });
		expect(out).toContain("`chamberlain steward prepare <your thread id> --live`");
		expect(out).toContain("`chamberlain steward publish-ref <id> wake --file <that temp> --live`");
		expect(out).toContain("publish-ref <id> compact");
		expect(out).toContain("`chamberlain steward switch <id> --live`");
		expect(out).not.toMatch(/\{\{|bun |<!--/);
	});
	test("from a checkout, it says `bun <checkout>/src/...`", () => {
		const out = renderStartPrompt(template, { conf: "/c", compiled: false, repo: "/opt/chamberlain" });
		expect(out).toContain("`bun /opt/chamberlain/src/brief.ts steward --mode live`");
		expect(out).toContain("steward-switch.ts prepare <your thread id> --live`");
		expect(out).toContain("steward-switch.ts publish-ref <id> wake");
		expect(out).toContain("steward-switch.ts switch <id> --live`");
	});
});
