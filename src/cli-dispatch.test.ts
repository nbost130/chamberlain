/**
 * CLI dispatcher and embedded static-file serving: split from cli.test.ts so each file stays under the line cap
 * after core import paths grew.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { debugUsage, run, usage, VERSION } from "./cli.ts";
import { COMMANDS, type CommandName, DEBUG_COMMANDS, REPO } from "./core/config/config.ts";
import { openCapability } from "./testing/capability.ts";
import { memStore } from "./testing/store.ts";
import { createApp } from "./web/app.ts";

describe("the page serves its embedded files", () => {
	test("staticFiles, not a directory, is where the page reads index.html, app.css, app.js and inline.js", async () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-static-`);
		const files: Record<string, [string, string]> = {
			"/index.html": ["<html>idx</html>", "text/html"],
			"/app.css": ["body{}", "text/css"],
			"/app.js": ["//app", "text/javascript"],
			"/inline.js": ["//inline", "text/javascript"],
		};
		const paths = Object.fromEntries(
			Object.entries(files).map(([url, [body]]) => {
				const p = `${dir}${url.replace("/", "/embedded-")}`;
				writeFileSync(p, body);
				return [url, p];
			}),
		);
		const host = "127.0.0.1:3790";
		const app = createApp({
			capability: openCapability(),
			store: memStore(),
			state: dir,
			log: () => {},
			hosts: [host],
			staticFiles: paths,
		});
		for (const [url, [body, type]] of Object.entries(files).filter(([u]) => u !== "/index.html")) {
			const r = await app.fetch(new Request(`http://${host}${url}`, { headers: { host } }));
			expect(r.status).toBe(200);
			expect(r.headers.get("content-type")).toStartWith(type);
			expect(await r.text()).toBe(body);
		}
		for (const url of ["/", "/rulings"])
			expect(await (await app.fetch(new Request(`http://${host}${url}`, { headers: { host } }))).text()).toBe(
				"<html>idx</html>",
			);
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
		console.log = (...a: unknown[]) => {
			lines.push(a.join(" "));
		};
		console.error = (...a: unknown[]) => {
			lines.push(a.join(" "));
		};
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
		} finally {
			console.log = log;
			console.error = err;
		}
		for (const name of Object.keys(COMMANDS) as CommandName[])
			expect(DEBUG_COMMANDS.includes(name as never) ? debugUsage() : usage()).toContain(name);
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
		console.log = (...a: unknown[]) => {
			lines.push(a.join(" "));
		};
		console.error = (...a: unknown[]) => {
			lines.push(a.join(" "));
		};
		try {
			expect(await run(["debug", "help"])).toBe(0);
			expect(lines.pop()).toBe(debugUsage());
			expect(await run(["debug"])).toBe(2);
			expect(await run(["debug", "ask"])).toBe(2);
			expect(lines.pop()).toContain('unknown debug command "ask"');
			// The same tool, by its new path and by the old name a prompt written earlier still uses.
			for (const argv of [
				["debug", "desk-allowlist", "check", "journalctl -n 5"],
				["desk-allowlist", "check", "journalctl -n 5"],
			]) {
				lines.length = 0;
				const exit = process.exit;
				let code: number | undefined;
				process.exit = ((c?: number) => {
					code = c;
					throw new Error("exit");
				}) as never;
				try {
					await run(argv);
				} catch {
					/* the tool exits through process.exit */
				} finally {
					process.exit = exit;
				}
				expect(code).toBe(0);
				expect(lines[0]).toBe("allow");
			}
		} finally {
			console.log = log;
			console.error = err;
		}
	});
	test("`bun src/cli.ts <tool>` runs the tool on a scratch state directory, like the tool's own file", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-cli-`);
		mkdirSync(`${dir}/state`, { recursive: true });
		mkdirSync(`${dir}/conf`, { recursive: true, mode: 0o700 });
		const {
			XDG_STATE_HOME: _s,
			XDG_CONFIG_HOME: _c,
			CHAMBERLAIN_STATE: _a,
			CHAMBERLAIN_CONF: _b,
			...rest
		} = process.env;
		const at = (...args: string[]) =>
			spawnSync(process.execPath, [join(REPO, "src/cli.ts"), ...args], {
				env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` },
				encoding: "utf8",
			});
		expect(at("--version").stdout.trim()).toBe(VERSION);
		const logged = at("decided", "Billing", "kept the default", "R1: standing rule");
		expect(logged.status).toBe(0);
		expect(at("decided", "list").stdout).toContain("kept the default");
		const bad = at("ruling");
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("usage: ruling.ts");
		expect(at("nope").status).toBe(2);
		const notJson = at("ask", "not json"); // one-line stderr, exit 1, as when the tool runs alone
		expect(notJson.status).toBe(1);
		expect(notJson.stderr.trim().split("\n")).toHaveLength(1);
	});
});
