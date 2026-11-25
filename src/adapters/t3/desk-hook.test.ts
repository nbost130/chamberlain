import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deskHook } from "./desk-hook.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
	const base = mkdtempSync(`${tmpdir()}/desk-hook-`);
	dirs.push(base);
	const [root, home, repo] = [`${base}/desk`, `${base}/home`, `${base}/repo`];
	for (const d of [`${root}/.claude`, `${home}/.claude`, `${repo}/src`]) mkdirSync(d, { recursive: true });
	writeFileSync(`${repo}/src/desk-allowlist.ts`, "");
	const managed = `${base}/managed.json`;
	const put = (path: string, value: unknown) =>
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	const hook = `bun ${repo}/src/desk-allowlist.ts hook`;
	const entry = (over: object = {}, hookOver: object = {}) => ({
		hooks: {
			PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, ...hookOver }], ...over }],
		},
	});
	return {
		base,
		root,
		home,
		repo,
		managed,
		hook,
		entry,
		put,
		project: (v: unknown) => put(`${root}/.claude/settings.json`, v),
		local: (v: unknown) => put(`${root}/.claude/settings.local.json`, v),
		user: (v: unknown) => put(`${home}/.claude/settings.json`, v),
		read: () => deskHook(root, { home, repo, managed }),
	};
}

describe("a proven hook", () => {
	test("this build's checkout, with the environment it runs with", () => {
		const w = world();
		w.project(w.entry());
		expect(w.read()).toEqual({});
		const command = `env DESK_ASK_PATH="$HOME/app/ask.ts" DESK_LOG_DIRS="\${HOME}/a:/b c" bun "${w.repo}/src/desk-allowlist.ts" hook`;
		w.project(w.entry({}, { command }));
		expect(w.read()).toEqual({ DESK_ASK_PATH: `${w.home}/app/ask.ts`, DESK_LOG_DIRS: `${w.home}/a:/b c` });
	});

	test("every spelling that covers every tool, the binary, a symlink to the checkout, and the local file", () => {
		for (const matcher of ["*", "", ".*", undefined]) {
			const w = world();
			w.project(w.entry({ matcher }));
			expect(w.read()).toEqual({});
		}
		for (const command of ["chamberlain desk-allowlist hook", "chamberlain debug desk-allowlist hook"]) {
			const w = world();
			w.local(w.entry({}, { command, timeout: 30 }));
			expect(w.read()).toEqual({});
		}
		const w = world();
		symlinkSync(w.repo, `${w.base}/link`);
		w.project(w.entry({}, { command: `/opt/bin/bun ${w.base}/link/src/desk-allowlist.ts hook` }));
		expect(w.read()).toEqual({});
	});
});

describe("no proof", () => {
	test("no settings, no hook, unreadable settings, or a setting that turns hooks off anywhere", () => {
		const w = world();
		expect(w.read()).toBeUndefined();
		for (const v of [
			"{",
			"[]",
			{},
			{ hooks: {} },
			{ hooks: { PreToolUse: "x" } },
			{ hooks: { PostToolUse: w.entry().hooks.PreToolUse } },
		]) {
			w.project(v);
			expect(w.read()).toBeUndefined();
		}
		const off: [(x: ReturnType<typeof world>) => void][] = [
			[(x) => x.project({ ...x.entry(), disableAllHooks: true })],
			[(x) => x.local({ disableAllHooks: true })],
			[(x) => x.user({ disableAllHooks: true })],
			[(x) => x.put(x.managed, { disableAllHooks: true })],
			[(x) => x.put(x.managed, { allowManagedHooksOnly: true })],
			[(x) => x.user("{")],
			[(x) => x.local("{")],
		];
		for (const [set] of off) {
			const x = world();
			x.project(x.entry());
			expect(x.read()).toEqual({});
			set(x);
			expect(x.read()).toBeUndefined();
		}
		const user = world();
		user.user(user.entry());
		expect(user.read()).toBeUndefined();
	});

	test("a narrower, conditional, background, short-lived or unknown form of the entry", () => {
		for (const over of [{ matcher: "Bash" }, { matcher: "Bash|Read" }, { if: "Bash(git *)" }, { hooks: "x" }]) {
			const w = world();
			w.project(w.entry(over));
			expect(w.read()).toBeUndefined();
		}
		for (const over of [
			{ type: "prompt" },
			{ async: true },
			{ if: "Bash(*)" },
			{ timeout: 1 },
			{ timeout: "9" },
			{ once: true },
		]) {
			const w = world();
			w.project(w.entry({}, over));
			expect(w.read()).toBeUndefined();
		}
	});

	test("a command that is not exactly this build's hook", () => {
		const w = world();
		mkdirSync(`${w.base}/other/src`, { recursive: true });
		writeFileSync(`${w.base}/other/src/desk-allowlist.ts`, "");
		mkdirSync(`${w.home}X/src`, { recursive: true });
		symlinkSync(`${w.repo}/src/desk-allowlist.ts`, `${w.home}X/src/desk-allowlist.ts`);
		for (const command of [
			`bun ${w.base}/other/src/desk-allowlist.ts hook`,
			`bun ${w.base}/gone/src/desk-allowlist.ts hook`,
			`bun src/desk-allowlist.ts hook`,
			`bun ${w.repo}/src/desk-allowlist.ts check`,
			`bun ${w.repo}/src/desk-allowlist.ts hook extra`,
			`node ${w.repo}/src/desk-allowlist.ts hook`,
			`bun -r ./x.ts ${w.repo}/src/desk-allowlist.ts hook`,
			`bun ${w.repo}/src/desk-allowlist.ts hook || true`,
			`bun ${w.repo}/src/desk-allowlist.ts hook; exit 0`,
			`$(bun ${w.repo}/src/desk-allowlist.ts hook)`,
			`BUN_OPTIONS=--preload=./x.ts bun ${w.repo}/src/desk-allowlist.ts hook`,
			`env PATH=/x bun ${w.repo}/src/desk-allowlist.ts hook`,
			`bun "${w.repo}/src/desk-allowlist.ts hook`,
			`bun $HOMEX/src/desk-allowlist.ts hook`,
			"chamberlain desk-allowlist check",
			"/tmp/chamberlain desk-allowlist hook",
			"",
			7,
		]) {
			w.project(w.entry({}, { command }));
			expect(w.read(), String(command)).toBeUndefined();
		}
	});
});
