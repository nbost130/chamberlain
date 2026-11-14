/**
 * `chamberlain mail`, run as the real command in a child process against a scratch config and state directory. With the module off it says
 * so, makes no file and exits 0; with it on, `status` makes mail.db and reads no mailbox.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFF } from "./cli.ts";
import { mailDbPath } from "./db.ts";

const CLI = new URL("../../cli.ts", import.meta.url).pathname;

function world(section?: object) {
	const root = mkdtempSync(join(tmpdir(), "mail-cli-"));
	const conf = join(root, "conf"),
		state = join(root, "state");
	mkdirSync(conf, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	if (section) writeFileSync(join(conf, "config.json"), JSON.stringify({ mail: section }), { mode: 0o600 });
	// A mail tool or a model CLI that the command starts leaves a mark: PATH holds a gog and a claude that only record being run.
	const bin = join(root, "bin"),
		spawned = join(root, "spawned");
	mkdirSync(bin);
	for (const tool of ["gog", "claude"]) {
		writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${spawned}"\n`, { mode: 0o755 });
		chmodSync(join(bin, tool), 0o755);
	}
	return { conf, state, bin, spawned };
}

async function mailCommand(w: { conf: string; state: string; bin: string }, ...args: string[]) {
	const p = Bun.spawn(["bun", CLI, "mail", ...args], {
		env: { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, CHAMBERLAIN_CONF: w.conf, CHAMBERLAIN_STATE: w.state },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { out: out.trim(), err: err.trim(), code };
}

describe("chamberlain mail", () => {
	test("with no mail section it says it is off, exits 0 and makes no file", async () => {
		const w = world();
		const r = await mailCommand(w);
		expect(r).toEqual({ out: OFF, err: "", code: 0 });
		expect(OFF).toBe("mail triage is off (config.json `mail.provider`)");
		expect(existsSync(mailDbPath(w.state))).toBe(false);
		expect(readdirSync(w.state)).toEqual([]);
		expect(existsSync(w.spawned)).toBe(false);
	});

	test('with "provider": "none", every subcommand says it is off and makes no file', async () => {
		const w = world({ provider: "none" });
		for (const args of [[], ["status"], ["help"], ["run"], ["undo", "m-1"]])
			expect(await mailCommand(w, ...args), args.join(" ")).toEqual({ out: OFF, err: "", code: 0 });
		expect(readdirSync(w.state)).toEqual([]);
		expect(existsSync(w.spawned)).toBe(false);
	});

	test("with the module on, status makes mail.db and says what is in force; it needs no mail access", async () => {
		const w = world({ provider: "gog", allowMailToLeaveMachine: true, gog: { command: "/nonexistent/gog" } });
		const r = await mailCommand(w, "status");
		expect(r.code).toBe(0);
		expect(r.err).toBe("");
		expect(r.out).toContain("mail triage: on (provider gog, mode shadow)");
		expect(r.out).toContain(`mail.db: ${mailDbPath(w.state)}, schema 1`);
		expect(r.out).toContain("schedule: 07:30, 16:30, mon-fri, local");
		expect(r.out).toContain("unattended archive: off");
		expect(existsSync(mailDbPath(w.state))).toBe(true);
		// It reads no mailbox and calls no model: neither tool was run.
		expect(existsSync(w.spawned)).toBe(false);
		// With no subcommand, `mail` is `mail status`.
		expect((await mailCommand(w)).out).toBe(r.out);
	});

	test("with the module on, an unknown subcommand is refused in one line and a bad section stops it, naming the key", async () => {
		const on = world({ provider: "gog", allowMailToLeaveMachine: true });
		const unknown = await mailCommand(on, "frobnicate");
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain('mail: unknown command "frobnicate"');
		const bad = world({ provider: "gog", allowMailToLeaveMachine: true, token: "x" });
		const r = await mailCommand(bad, "status");
		expect(r.code).toBe(1);
		expect(r.err).toContain('mail: unknown key "token"');
		expect(existsSync(mailDbPath(bad.state))).toBe(false);
	});
});
