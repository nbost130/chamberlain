/** desk-allowlist, continued: see desk-allowlist.test.ts for the overview. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selfCommand, setCompiled } from "./core/config/config.ts";
import { deskAskCommand, renderDeskPrompt } from "./core/desk/alert-desk-prompt.ts";
import { checkCommand } from "./desk-allowlist.ts";
import { ASK, allowed, MONITOR, refused } from "./testing/desk-allowlist-fixtures.ts";

describe("the standing prompt's own ask command passes the real allowlist", () => {
	const template = readFileSync(new URL("../docs/alert-desk-prompt.md", import.meta.url), "utf8");
	const vars = { principalName: "Ada", serverName: "box-1", repo: "/opt/chamberlain", morning: { commands: [] } };
	/** The one line of the rendered prompt that files a decision. */
	const askLine = (askCommand: string) => {
		const lines = renderDeskPrompt(template, {
			...vars,
			allowlistHook: `${selfCommand("desk-allowlist")} hook`,
			askCommand,
		})
			.split("\n")
			.filter((l) => l.includes(' \'{"kind":'));
		expect(lines).toHaveLength(1);
		return lines[0]!;
	};
	const hook = (cmd: string, env: Record<string, string | undefined>) => {
		const p = Bun.spawnSync(["bun", new URL("./desk-allowlist.ts", import.meta.url).pathname, "check", cmd], {
			env: env as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: p.exitCode, out: p.stdout.toString().trim() };
	};

	test("rendered with the path the hook uses (DESK_ASK_PATH unset: this checkout's src/ask.ts), the line is allowed, in process and by the hook's own entry point", () => {
		const env = { ...process.env };
		delete env.DESK_ASK_PATH;
		const line = askLine(deskAskCommand(env));
		expect(line.startsWith(`${deskAskCommand(env)} '{`)).toBe(true);
		expect(line).not.toContain("cd ");
		expect(checkCommand(line, { morning: [], shapes: {} })).toEqual({ ok: true });
		expect(hook(line, env)).toEqual({ code: 0, out: "allow" });
	});

	test("rendered with DESK_ASK_PATH, the line is allowed by a hook that has the same DESK_ASK_PATH, and refused by one without it", () => {
		const env = { ...process.env, DESK_ASK_PATH: "/srv/deployed/chamberlain/src/ask.ts" };
		const line = askLine(deskAskCommand(env));
		expect(line.startsWith("bun /srv/deployed/chamberlain/src/ask.ts '{")).toBe(true);
		expect(hook(line, env)).toEqual({ code: 0, out: "allow" });
		const without = { ...process.env };
		delete without.DESK_ASK_PATH;
		expect(hook(line, without).code).toBe(2);
	});

	test("the old spelling, `cd <repo> && bun src/ask.ts`, is refused: the template no longer teaches it", () => {
		expect(template).not.toContain("bun src/ask.ts");
		expect(template).toContain("{{askCommand}} '");
		expect(
			checkCommand(`cd /opt/chamberlain && bun src/ask.ts '{"kind":"product"}'`, { morning: [], shapes: {} }).ok,
		).toBe(false);
	});
});

describe("the allowlist matches exactly: nothing is trimmed or normalised", () => {
	const PLAIN = `bun ${MONITOR} heartbeat --json`;
	const SLOT = `bun ${MONITOR} list --limit 12 --json`;
	const FILE = `${ASK} '{"kind":"product","title":"t","options":[{"label":"a"}]}'`;
	const SPACES: Record<string, string> = {
		space: " ",
		tab: "\t",
		newline: "\n",
		"carriage return and newline": "\r\n",
		"no-break space": "\u00a0",
		"byte-order mark": "\ufeff",
		"vertical tab": "\v",
		"form feed": "\f",
		"line separator": "\u2028",
	};
	test.each([
		["a morning command with no slot", PLAIN],
		["a morning command with a <N> slot", SLOT],
		["filing a decision", FILE],
	])("%s is allowed exactly as written", (_what, cmd) => allowed(cmd));
	for (const [what, cmd] of [
		["a morning command with no slot", PLAIN],
		["a morning command with a <N> slot", SLOT],
		["filing a decision", FILE],
	] as const) {
		for (const [name, ws] of Object.entries(SPACES)) {
			test(`${what}, with a leading ${name}, is refused`, () => {
				refused(`${ws}${cmd}`);
			});
			test(`${what}, with a trailing ${name}, is refused`, () => {
				refused(`${cmd}${ws}`);
			});
		}
		test(`${what}, with a doubled inner space, is refused`, () => {
			refused(cmd.replace(" ", "  "));
		});
	}
});

describe("in the compiled binary the desk files a decision with `chamberlain ask`", () => {
	const template = readFileSync(new URL("../docs/alert-desk-prompt.md", import.meta.url), "utf8");
	const saved = process.env.DESK_ASK_PATH;
	afterEach(() => {
		setCompiled();
		if (saved === undefined) delete process.env.DESK_ASK_PATH;
		else process.env.DESK_ASK_PATH = saved;
	});

	test("the prompt teaches `chamberlain ask '<json>'`, and the allowlist accepts that and not the source spelling", () => {
		delete process.env.DESK_ASK_PATH;
		setCompiled(true);
		expect(deskAskCommand()).toBe("chamberlain ask");
		const out = renderDeskPrompt(template, {
			principalName: "Ada",
			serverName: "box-1",
			allowlistHook: `${selfCommand("desk-allowlist")} hook`,
			askCommand: deskAskCommand(),
			morning: { commands: [] },
		});
		const line = out.split("\n").find((l) => l.includes(' \'{"kind":'))!;
		expect(line.startsWith("chamberlain ask '{")).toBe(true);
		expect(out).toContain("`chamberlain debug desk-allowlist hook` (Chamberlain's desk allowlist)");
		expect(checkCommand(line, { morning: [], shapes: {} })).toEqual({ ok: true });
		expect(checkCommand(`chamberlain ask '{}' ; id`, { morning: [], shapes: {} }).ok).toBe(false);
		expect(
			checkCommand(`bun ${selfCommand("ask", { compiled: false }).slice(4)} '{}'`, { morning: [], shapes: {} }).ok,
		).toBe(false);
	});
});
