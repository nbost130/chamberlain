/**
 * The standalone binary's front door: the dispatcher, and the one helper that renders every command an agent or an operator is told to run.
 * The same strings are rendered twice, as the compiled binary would (`chamberlain <sub>`) and from source (`bun <checkout>/src/....ts`).
 * scripts/smoke.ts proves the real compiled binary does the first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { mandateLine } from "./core/afk.ts";
import { stewardBrief, type BriefInput } from "./core/brief.ts";
import { COMMANDS, DEBUG_COMMANDS, REPO, selfArgv, selfCommand, setCompiled, type CommandName } from "./core/config.ts";
import { sweepMessage, type SweepAction } from "./core/sweep.ts";
import { t3Brief } from "./adapters/t3/brief.ts";
import { createApp } from "./web/app.ts";
import { memStore } from "./testing/store.ts";
import { debugUsage, run, usage, VERSION } from "./cli.ts";

afterEach(() => setCompiled());

describe("selfCommand: one helper renders every command string", () => {
	test("compiled, it is `chamberlain <sub>`; from source, `bun <checkout>/<file>`", () => {
		expect(selfCommand("ask", { compiled: true })).toBe("chamberlain ask");
		expect(selfCommand("afk", { compiled: true })).toBe("chamberlain afk");
		expect(selfCommand("ask", { compiled: false })).toBe(`bun ${REPO}/src/ask.ts`);
		expect(selfCommand("afk", { compiled: false })).toBe(`bun ${REPO}/src/core/afk.ts`);
		expect(selfCommand("peek", { compiled: false, repo: "/opt/chamberlain" })).toBe("bun /opt/chamberlain/src/adapters/t3/peek.ts");
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
		const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
		const offenders = walk(join(REPO, "src"))
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("/core/config.ts"))
			.filter((f) => /bun \$\{[^}]*\}\/src\//.test(readFileSync(f, "utf8")) || /new URL\("[^"]*\.ts", import\.meta\.url\)\.pathname\}/.test(readFileSync(f, "utf8")) || /process\.execPath,\s*new URL\(/.test(readFileSync(f, "utf8")));
		expect(offenders).toEqual([]);
	});
});

describe("every prompt-embedded command, rendered both ways", () => {
	const afk = { enteredAt: "2026-11-02T03:46:27Z", words: "keep going" };
	/** Built at call time: the adapter's sentences, like every other, are rendered for the build that is running. */
	const brief = (): BriefInput => ({ mode: "live", repo: "/opt/chamberlain", principal: "Ada", rights: "r", rulings: "x", operatingRules: "", afk, environments: [{ name: "main" }], predecessor: undefined, notes: t3Brief({ repo: "/opt/chamberlain" }) });
	/** A failed check names the missing string, not the whole hand-off. */
	const has = (out: string, s: string) => expect(out.includes(s), `missing: ${s}`).toBe(true);
	const action = { wake: "routine", fresh: [{ key: "check:a", text: "a thing" }] } as unknown as SweepAction;
	const render = () => [stewardBrief(brief()), sweepMessage(action, "BODY"), mandateLine(afk)].join("\n");

	test("from source they name `bun .../src/....ts`", () => {
		const out = render();
		for (const c of ["bun /opt/chamberlain/src/ask.ts '<json>'", "bun /opt/chamberlain/src/core/afk.ts hold", "bun /opt/chamberlain/src/core/afk.ts held", "bun /opt/chamberlain/src/core/decided.ts list 15", "bun /opt/chamberlain/src/core/ruling.ts --stated-in-chat", "bun /opt/chamberlain/src/adapters/t3/peek.ts <server> <threadId>", "bun /opt/chamberlain/src/adapters/t3/t3x.ts threads|read|respond|send <server>"]) has(out, c);
		// The sweep wake and the away mandate are built without a repo argument: they name this checkout.
		has(out, `bun ${REPO}/src/ask.ts '<json>'`);
		has(out, `bun ${REPO}/src/core/afk.ts hold ... --item`);
		expect(out.includes("chamberlain ask")).toBe(false);
	});
	test("compiled they name `chamberlain <sub>`, and no checkout path is left in any of them", () => {
		setCompiled(true);
		const out = render();
		for (const c of ["chamberlain ask '<json>'", "chamberlain afk hold", "chamberlain afk held", "chamberlain afk status", "chamberlain afk note", "chamberlain afk close ", "chamberlain decided list 15", "chamberlain ruling --stated-in-chat", "chamberlain debug peek <server> <threadId>", "chamberlain debug t3x threads|read|respond|send <server>"]) has(out, c);
		expect(out.match(/\bbun \S*\/src\/\S*/g)).toBeNull();
		expect(out.includes("/opt/chamberlain")).toBe(false);
		expect(out.includes(REPO)).toBe(false);
	});
});

describe("the page serves its embedded files", () => {
	test("staticFiles, not a directory, is where the page reads index.html, app.css, app.js and inline.js", async () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-static-`);
		const files: Record<string, [string, string]> = { "/index.html": ["<html>idx</html>", "text/html"], "/app.css": ["body{}", "text/css"], "/app.js": ["//app", "text/javascript"], "/inline.js": ["//inline", "text/javascript"] };
		const paths = Object.fromEntries(Object.entries(files).map(([url, [body]]) => { const p = `${dir}${url.replace("/", "/embedded-")}`; writeFileSync(p, body); return [url, p]; }));
		const host = "127.0.0.1:3790";
		const app = createApp({ store: memStore(), state: dir, log: () => {}, hosts: [host], staticFiles: paths });
		for (const [url, [body, type]] of Object.entries(files).filter(([u]) => u !== "/index.html")) {
			const r = await app.fetch(new Request(`http://${host}${url}`, { headers: { host } }));
			expect(r.status).toBe(200);
			expect(r.headers.get("content-type")).toStartWith(type);
			expect(await r.text()).toBe(body);
		}
		for (const url of ["/", "/rulings"]) expect(await (await app.fetch(new Request(`http://${host}${url}`, { headers: { host } }))).text()).toBe("<html>idx</html>");
	});
});

describe("the dispatcher", () => {
	test("every tool has a source file with a main(argv) the dispatcher can call, and still runs on its own from a checkout", () => {
		for (const [name, file] of Object.entries(COMMANDS)) {
			const path = join(REPO, file);
			expect(existsSync(path), `${name}: ${file}`).toBe(true);
			const text = readFileSync(path, "utf8");
			expect(text, `${name} exports main`).toMatch(/export (async )?function main\(/);
			expect(text, `${name} runs itself as a script`).toContain("if (import.meta.main)");
		}
	});
	test("--version and help are answered without loading anything; an unknown command is exit 2", async () => {
		const lines: string[] = [];
		const log = console.log;
		const err = console.error;
		console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
		console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
		try {
			expect(await run(["--version"])).toBe(0);
			expect(lines.pop()).toBe(VERSION);
			expect(VERSION).toBe(pkg.version);
			expect(await run(["help"])).toBe(0);
			expect(lines.pop()).toBe(usage());
			expect(await run([])).toBe(2);
			lines.length = 0;
			expect(await run(["nope"])).toBe(2);
			expect(lines.join("\n")).toContain('unknown command "nope"');
			expect(await run(["constructor"])).toBe(2);
		} finally { console.log = log; console.error = err; }
		for (const name of Object.keys(COMMANDS) as CommandName[]) expect(DEBUG_COMMANDS.includes(name as never) ? debugUsage() : usage()).toContain(name);
	});
	test("the diagnostic commands are listed under `debug`, not on the front page, and still run under their old names", async () => {
		for (const name of DEBUG_COMMANDS) {
			expect(usage()).not.toContain(`  ${name} `);
			expect(debugUsage()).toContain(name);
		}
		expect(usage()).toContain("chamberlain debug help");
		const lines: string[] = [];
		const log = console.log;
		const err = console.error;
		console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
		console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
		try {
			expect(await run(["debug", "help"])).toBe(0);
			expect(lines.pop()).toBe(debugUsage());
			expect(await run(["debug"])).toBe(2);
			expect(await run(["debug", "ask"])).toBe(2);
			expect(lines.pop()).toContain('unknown debug command "ask"');
			// The same tool, by its new path and by the old name a prompt written earlier still uses.
			for (const argv of [["debug", "desk-allowlist", "check", "journalctl -n 5"], ["desk-allowlist", "check", "journalctl -n 5"]]) {
				lines.length = 0;
				const exit = process.exit;
				let code: number | undefined;
				process.exit = ((c?: number) => { code = c; throw new Error("exit"); }) as never;
				try { await run(argv); } catch { /* the tool exits through process.exit */ } finally { process.exit = exit; }
				expect(code).toBe(0);
				expect(lines[0]).toBe("allow");
			}
		} finally { console.log = log; console.error = err; }
	});
	test("`bun src/cli.ts <tool>` runs the tool on a scratch state directory, like the tool's own file", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-cli-`);
		mkdirSync(`${dir}/state`, { recursive: true });
		mkdirSync(`${dir}/conf`, { recursive: true, mode: 0o700 });
		const { XDG_STATE_HOME: _s, XDG_CONFIG_HOME: _c, CHAMBERLAIN_STATE: _a, CHAMBERLAIN_CONF: _b, ...rest } = process.env;
		const at = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "src/cli.ts"), ...args], { env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` }, encoding: "utf8" });
		expect(at("--version").stdout.trim()).toBe(VERSION);
		const logged = at("decided", "Billing", "kept the default", "R1: standing rule");
		expect(logged.status).toBe(0);
		expect(at("decided", "list").stdout).toContain("kept the default");
		const bad = at("ruling");
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("usage: ruling.ts");
		expect(at("nope").status).toBe(2);
		// A tool's error is one line and exit 1, as when it runs on its own.
		const notJson = at("ask", "not json");
		expect(notJson.status).toBe(1);
		expect(notJson.stderr.trim().split("\n")).toHaveLength(1);
	});
});
