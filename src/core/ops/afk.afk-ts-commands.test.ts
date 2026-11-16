/** afk, continued: see afk.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore } from "../store/sqlite-store.ts";
import { dbPath } from "../store/store.ts";
import { appendHeld, heldOpen, readAfk } from "./afk-held.ts";

describe("afk.ts commands", () => {
	/** afk.ts as a real process on a scratch state directory. */
	function cli(dir: string, ...args: string[]) {
		const { XDG_STATE_HOME: _s, XDG_CACHE_HOME: _c, XDG_CONFIG_HOME: _f, CHAMBERLAIN_STATE: _a, ...rest } = process.env;
		return spawnSync(process.execPath, [new URL("./afk.ts", import.meta.url).pathname, ...args], {
			env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` },
			encoding: "utf8",
		});
	}
	const scratch = () => mkdtempSync(`${tmpdir()}/chamberlain-afkcmd-`);
	const open = (dir: string) => openStore(dbPath(`${dir}/state`));

	test("no command or an unknown one prints the usage and exits 2", () => {
		const dir = scratch();
		for (const args of [[], ["bogus"]]) {
			const r = cli(dir, ...args);
			expect(r.status).toBe(2);
			expect(r.stderr).toBe("usage: afk.ts enter|status|hold|held|note|close|close-card|brief|exit\n");
		}
	});

	test("enter needs his words (a flag's value is not them), and records the flags it is given", () => {
		const dir = scratch();
		for (const args of [["enter"], ["enter", "--return", "2026-11-20T12:00:00Z"], ["enter", "--cap"]]) {
			const r = cli(dir, ...args);
			expect(r.status).toBe(2);
			expect(r.stderr).toBe('usage: afk.ts enter "<their words>" [--return ISO] [--cap "<note>"]\n');
		}
		const r = cli(
			dir,
			"enter",
			"--since",
			"2026-11-14T10:00:00.000Z",
			"back for lunch",
			"--return",
			"2026-11-14T18:00:00Z",
			"--cap",
			"no spend",
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("away since 2026-11-14T10:00:00.000Z\n");
		const store = open(dir);
		expect(readAfk(store)).toEqual({
			enteredAt: "2026-11-14T10:00:00.000Z",
			words: "back for lunch",
			expectedReturn: "2026-11-14T18:00:00Z",
			spendNote: "no spend",
		});
		store.close();
	});

	test("status, brief and exit say 'not away' when no absence is open, and exit ends one after printing its brief", () => {
		const dir = scratch();
		expect(cli(dir, "status").stdout).toBe("not away\nheartbeat: none\n");
		expect(cli(dir, "brief").stdout).toBe("not away\n");
		expect(cli(dir, "exit").stdout).toBe("not away\n");
		expect(cli(dir, "enter", "walking the dog", "--since", "2026-11-14T10:00:00.000Z").status).toBe(0);
		const status = cli(dir, "status");
		expect(status.status).toBe(0);
		expect(status.stdout).toContain("walking the dog");
		expect(status.stdout).toContain("heartbeat: none");
		const brief = cli(dir, "brief").stdout;
		expect(brief).toContain("walking the dog");
		const exit = cli(dir, "exit");
		expect(exit.status).toBe(0);
		expect(exit.stdout).toContain("walking the dog");
		expect(exit.stdout.endsWith("\nreturned; the absence is ended and stays on record\n")).toBe(true);
		expect(cli(dir, "status").stdout).toBe("not away\nheartbeat: none\n");
	});

	test("note and close ask for their arguments, and refuse an unknown hold with exit 1", () => {
		const dir = scratch();
		expect(cli(dir, "note", "abc")).toMatchObject({
			status: 2,
			stderr: 'usage: afk.ts note <id> "<what changed>"\n',
		});
		expect(cli(dir, "close", "abc")).toMatchObject({
			status: 2,
			stderr: 'usage: afk.ts close <id> "<how it closed>"\n',
		});
		expect(cli(dir, "close-card", "main", "r1")).toMatchObject({
			status: 2,
			stderr: 'usage: afk.ts close-card <server> <request id> "<how it closed>"\n',
		});
		expect(cli(dir, "note", "deadbeef", "x")).toMatchObject({ status: 1, stderr: "no open held item deadbeef\n" });
		expect(cli(dir, "close", "deadbeef", "x")).toMatchObject({ status: 1, stderr: "no open held item deadbeef\n" });
		expect(cli(dir, "close-card", "main", "r1", "x")).toMatchObject({
			status: 1,
			stderr: "no open card hold or question for main request r1\n",
		});
	});

	test("close ends an ordinary hold by its handle and names its thread", () => {
		const dir = scratch();
		mkdirSync(`${dir}/state`, { recursive: true });
		const store = open(dir);
		const id = appendHeld(store, { thread: "Billing", what: "approve it" });
		store.close();
		expect(cli(dir, "note", id, "later")).toMatchObject({ status: 0, stdout: "noted: Billing\n" });
		expect(cli(dir, "close", id, "done by hand")).toMatchObject({ status: 0, stdout: "closed: Billing\n" });
		const after = open(dir);
		expect(heldOpen(after)).toEqual([]);
		after.close();
	});

	test("close on a daemon's card hold closes the card with its pointer question; close-card does the same by request ID", () => {
		const dir = scratch();
		mkdirSync(`${dir}/state`, { recursive: true });
		const store = open(dir);
		const byCard = appendHeld(store, {
			thread: "Steward",
			what: "approve",
			card: { server: "main", threadId: "th-card1", requestId: "req-1" },
		});
		const byRequest = appendHeld(store, {
			thread: "Steward",
			what: "approve the second",
			server: "main",
			requestId: "req-2",
		});
		appendHeld(store, {
			thread: "Steward",
			what: "approve the third",
			card: { server: "main", threadId: "th-card3", requestId: "req-3" },
		});
		store.close();
		expect(cli(dir, "close", byCard, "seen")).toMatchObject({
			status: 0,
			stdout: "closed card main req-1: 1 hold(s), 0 question(s)\n",
		});
		expect(cli(dir, "close", byRequest, "seen")).toMatchObject({
			status: 0,
			stdout: "closed card main req-2: 1 hold(s), 0 question(s)\n",
		});
		expect(cli(dir, "close-card", "main", "req-3", "seen")).toMatchObject({
			status: 0,
			stdout: "closed card main req-3: 1 hold(s), 0 question(s)\n",
		});
		const after = open(dir);
		expect(heldOpen(after)).toEqual([]);
		after.close();
	}, 30_000);
});
