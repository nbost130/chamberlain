/** afk, continued: see afk.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { a } from "../testing/core-afk-fixtures.ts";
import { memStore } from "../testing/store.ts";
import { briefMarkdown } from "./afk.ts";
import { appendHeld, cleanRef, closeHeld, fyiReason, heldId, heldOpen, noteHeld } from "./afk-held.ts";
import { askQuestion, type Question } from "./questions.ts";
import { openStore } from "./sqlite-store.ts";
import { dbPath } from "./store.ts";

describe("hold refs, notes and the CLI", () => {
	/** afk.ts as a real process on a scratch state directory. */
	function cli(dir: string, ...args: string[]) {
		const { XDG_STATE_HOME: _s, XDG_CACHE_HOME: _c, XDG_CONFIG_HOME: _f, CHAMBERLAIN_STATE: _a, ...rest } = process.env;
		return spawnSync(process.execPath, [new URL("./afk.ts", import.meta.url).pathname, ...args], {
			env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` },
			encoding: "utf8",
		});
	}
	const open = (dir: string) => openStore(dbPath(`${dir}/state`));
	const scratch = () => mkdtempSync(`${tmpdir()}/chamberlain-afk-`);
	/** Files a question on the scratch queue, as ask.ts would, so a hold can name it with --item. */
	const queued = (dir: string, id = "Q-abcd1", extra: Partial<Question> = {}) => {
		mkdirSync(`${dir}/state`, { recursive: true });
		const s = open(dir);
		askQuestion(s, {
			id,
			kind: "only-you",
			title: `question ${id}`,
			context: "",
			options: [{ label: "A" }, { label: "B" }],
			thread: "T",
			server: "main",
			createdAt: new Date().toISOString(),
			...extra,
		});
		s.close();
		return id;
	};

	test("hold takes --pr, --issue, --branch, --run and --thread and stores them as a structured ref", () => {
		const dir = scratch();
		queued(dir);
		const r = cli(
			dir,
			"hold",
			"Billing",
			"approve the migration",
			"left it parked",
			"--pr",
			"example-org/app#962",
			"--issue",
			"o/r#5",
			"--branch",
			"o/r:feat/x",
			"--run",
			"01JRUN1234",
			"--thread",
			"th-abc1",
			"--item",
			"Q-abcd1",
		);
		expect(r.status).toBe(0);
		const store = open(dir);
		expect(heldOpen(store)[0]).toMatchObject({
			thread: "Billing",
			what: "approve the migration",
			taken: "left it parked",
			item: "Q-abcd1",
			ref: {
				pr: "example-org/app#962",
				issue: "o/r#5",
				branch: "o/r:feat/x",
				runId: "01JRUN1234",
				threadId: "th-abc1",
			},
		});
		store.close();
	});

	test("a hold with no flags has no ref, and the old positional card threadId still works", () => {
		const dir = scratch();
		expect(cli(dir, "hold", "A", "waits", "", "th-card1", "--item", queued(dir)).status).toBe(0);
		const store = open(dir);
		const h = heldOpen(store)[0]!;
		expect(h.ref).toBeUndefined();
		expect(h.threadId).toBe("th-card1");
		store.close();
	});

	test("a malformed ref, an unknown flag or a flag with no value is refused with usage and writes nothing", () => {
		const dir = scratch();
		for (const bad of [
			["--pr", "962"],
			["--pr", "o/r#x"],
			["--branch", "o/r"],
			["--issue", "o/r#1; rm"],
			["--bogus", "x"],
			["--pr"],
			["--item", "nope"],
		]) {
			const r = cli(dir, "hold", "A", "waits", ...bad);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage: afk.ts hold");
		}
		const store = open(dir);
		expect(heldOpen(store)).toHaveLength(0);
		store.close();
	});

	test("cleanRef keeps only well-formed fields", () => {
		expect(cleanRef({ pr: "a/b#1", branch: "no", extra: "x" })).toEqual({ pr: "a/b#1" });
		expect(cleanRef({ pr: 5 })).toBeUndefined();
		expect(cleanRef("a/b#1")).toBeUndefined();
	});

	test("note appends to the original hold, shows in held and the brief, and makes no second entry", () => {
		const dir = scratch();
		expect(cli(dir, "hold", "Billing", "approve the migration", "--item", queued(dir)).status).toBe(0);
		const store = open(dir);
		const h = heldOpen(store)[0]!;
		store.close();
		const r = cli(dir, "note", heldId(h), "Wanted after the 15th");
		expect(r.status).toBe(0);
		const after = open(dir);
		expect(heldOpen(after)).toHaveLength(1);
		expect(heldOpen(after)[0]!.notes?.map((n) => n.text)).toEqual(["Wanted after the 15th"]);
		expect(briefMarkdown(a, [], heldOpen(after), [])).toContain("  - note ");
		after.close();
		const held = cli(dir, "held").stdout;
		expect(held).toContain(`${heldId(h)} |`);
		expect(held).toContain("note ");
		expect(held).toContain("Wanted after the 15th");
	});

	test("a note on an unknown or closed hold is refused, and notes accumulate in order", () => {
		const store = memStore();
		const id = appendHeld(store, { thread: "A", what: "waits" }, new Date("2026-11-06T01:00:00Z"));
		noteHeld(store, id, "first", new Date("2026-11-06T02:00:00Z"));
		noteHeld(store, id, "second", new Date("2026-11-06T03:00:00Z"));
		expect(heldOpen(store)[0]!.notes?.map((n) => n.text)).toEqual(["first", "second"]);
		expect(() => noteHeld(store, "deadbeef", "x")).toThrow("no open held item deadbeef");
		closeHeld(store, id, "done");
		expect(() => noteHeld(store, id, "late")).toThrow("no open held item");
	});

	// "no action from builders" in a real hold's text was refused.
	test("fix 3: hold refuses an FYI that opens the thread or the text, with a non-zero exit, and points at decided.ts", () => {
		const dir = scratch();
		for (const [thread, what] of [
			["FYI", "build passed"],
			["CI", "FYI only: build passed"],
			["CI", "  ...For your information, the deploy finished"],
			["CI", "no action needed, all green"],
			["CI", "Nothing needed from the operator"],
			["[FYI] Billing", "migration ran"],
			["Notes", "nothing required"],
			["Notes", "(FYI) done"],
		]) {
			const r = cli(dir, "hold", thread!, what!);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("refused");
			expect(r.stderr).toContain("decided.ts");
		}
		const store = open(dir);
		expect(heldOpen(store)).toHaveLength(0);
		store.close();
	}, 60_000); // starts eight CLI processes one after another: 5.1 s seen under load, so the 5 s default flakes

	test("fix 3: a real wait that merely says 'no action' or 'nothing' somewhere passes", () => {
		const dir = scratch();
		const q = queued(dir);
		for (const [thread, what] of [
			["Billing", "waits on the operator; no action from builders until then"],
			["Deploy", "approve the release. Nothing needed from the build until they say go"],
			["Secrets", "rotate the Stripe key; it is not an FYI, only they can"],
			["App", "decide whether a one-way gate is needed"],
		]) {
			expect(fyiReason(thread!, what!)).toBeUndefined();
			expect(cli(dir, "hold", thread!, what!, "left it parked", "--item", q).status).toBe(0);
		}
		expect(cli(dir, "hold", "PR", "merge approval", "", "", "--pr", "o/r#5", "--item", q).status).toBe(0);
		const store = open(dir);
		expect(heldOpen(store)).toHaveLength(5);
		store.close();
		expect(fyiReason("x", "FYI")).toBe('"FYI"');
	});

	test("fix 1: --server names the thread's server, only beside a thread, and is stored on the hold", () => {
		const dir = scratch();
		const q = queued(dir);
		expect(cli(dir, "hold", "A", "waits", "", "", "--thread", "th-abc1", "--server", "main", "--item", q).status).toBe(
			0,
		);
		expect(cli(dir, "hold", "B", "waits", "", "th-card1", "--server", "second", "--item", q).status).toBe(0);
		expect(cli(dir, "hold", "C", "waits", "", "", "--server", "main").status).toBe(2);
		expect(cli(dir, "hold", "D", "waits", "", "", "--thread", "th-abc1", "--server", "ma in").status).toBe(2);
		const store = open(dir);
		expect(heldOpen(store).map((h) => [h.thread, h.server])).toEqual([
			["A", "main"],
			["B", "second"],
		]);
		store.close();
	});
});
