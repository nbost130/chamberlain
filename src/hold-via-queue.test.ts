/**
 * Queue first, hold second, settled never twice: ask.ts and `afk.ts hold` as real processes on a scratch state directory.
 *   (a) a hold needs --item naming an open question on the queue; `"urgent": false` records a question and posts nothing.
 *   (b) both refuse what is already settled (exit 2, with what matched), unless given a reason, which is stored.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { heldOpen } from "./core/afk-held.ts";
import { getQuestion, questionStates } from "./core/questions.ts";
import { claimWake, pageClaim } from "./core/questions-claim.ts";
import { ranked } from "./core/questions-wake.ts";
import { openStore } from "./core/sqlite-store.ts";
import { dbPath, type Store } from "./core/store.ts";

type Dir = string;
const scratch = (): Dir => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-hvq-`);
	mkdirSync(`${d}/state`, { recursive: true });
	mkdirSync(`${d}/conf`, { recursive: true, mode: 0o700 });
	return d;
};
function run(dir: Dir, script: string, ...args: string[]) {
	const {
		XDG_STATE_HOME: _s,
		XDG_CACHE_HOME: _c,
		XDG_CONFIG_HOME: _f,
		CHAMBERLAIN_STATE: _a,
		CHAMBERLAIN_CONF: _g,
		CHAMBERLAIN_PRINCIPAL: _p,
		...rest
	} = process.env;
	return spawnSync(process.execPath, [new URL(script, import.meta.url).pathname, ...args], {
		env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` },
		encoding: "utf8",
	});
}
const BASE = {
	kind: "product",
	context: "- one line",
	options: [{ label: "Yes" }, { label: "No" }],
	thread: "Billing",
	server: "main",
};
const ask = (dir: Dir, o: Record<string, unknown>) => run(dir, "./ask.ts", JSON.stringify({ ...BASE, ...o }));
const afk = (dir: Dir, ...args: string[]) => run(dir, "./core/afk.ts", ...args);
const idOf = (r: { stdout: string }) => r.stdout.match(/\bQ-[a-z0-9]{4,16}\b/)![0];
function withStore<T>(dir: Dir, fn: (s: Store) => T): T {
	const s = openStore(dbPath(`${dir}/state`));
	try {
		return fn(s);
	} finally {
		s.close();
	}
}
/** Answers a question as the page would. */
const settle = (dir: Dir, id: string, label = "No") =>
	withStore(dir, (s) => {
		const q = getQuestion(s, id)!;
		claimWake(
			s,
			pageClaim(q, { choice: 1, label, by: "page", t: new Date().toISOString(), deliveryId: `answer:item:${id}` }),
		);
	});

describe("(a) everything that waits on the operator goes through the queue first", () => {
	test('"urgent": false records the question, posts nothing, and says so', () => {
		const d = scratch();
		const r = ask(d, { urgent: false, title: "Pick a colour for the billing badge" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("not urgent: no notification sent");
		expect(withStore(d, (s) => getQuestion(s, idOf(r))!.urgent)).toBe(false);
		expect(ask(d, { urgent: "no", title: "x" }).stderr).toContain('"urgent" must be true or false');
	});
	test('(1) "urgent": false on an approval or a secret is ignored with a note on stderr: it is filed urgent, and an approval goes on to its post', () => {
		const d = scratch();
		for (const [o, what] of [
			[{ tag: "Approval", title: "Approve the payroll export" }, "an approval"],
			[{ tag: "approval", title: "Approve the ledger rebuild" }, "an approval"],
			[{ secret: true, options: [], title: "Paste the payroll API key" }, "a secret"],
			[{ tag: "Secret", title: "Rotate the vendor key" }, "a secret"],
		] as const) {
			const r = ask(d, { ...o, urgent: false, notSettled: "test" });
			expect(r.stderr).toContain(`"urgent": false ignored: ${what} is always urgent`);
			expect(r.stdout).not.toContain("not urgent");
			const q = withStore(d, (s) => [...questionStates(s).values()].find((x) => x.title === o.title));
			expect(q).toBeDefined();
			expect(q!.urgent).toBeUndefined();
			// A secret is never posted. An approval goes on to its post: with no backend configured here that post fails (exit 1),
			// where a question that may wait would have stopped before it and exited 0.
			if ("secret" in o) expect([r.status, r.stdout]).toEqual([0, expect.stringContaining("(secret:")]);
			else expect(r.status).toBe(1);
		}
		// An ordinary question keeps its demotion.
		expect(ask(d, { urgent: false, title: "Pick a colour for the docs badge" }).stdout).toContain(
			"not urgent: no notification sent",
		);
	});
	test("a non-urgent question ranks below every urgent one, even one set aside with not now", () => {
		const d = scratch();
		const nu = idOf(ask(d, { urgent: false, kind: "only-you", title: "Waits a while" }));
		withStore(d, (s) => {
			// Urgent questions written straight to the store: ask.ts would also post them.
			for (const [id, kind] of [
				["Q-urg01", "idea"],
				["Q-urg02", "product"],
			] as const)
				s.items.observe({
					source: "queue",
					kind: "question",
					dedupKey: id,
					mode: "silenced",
					payload: { ...BASE, id, kind, title: id, createdAt: new Date().toISOString() },
					now: Date.now(),
				});
			s.items.acknowledge("queue", "Q-urg02", Date.now(), { notNowAt: new Date().toISOString() });
			expect(ranked(questionStates(s).values()).map((q) => q.id)).toEqual(["Q-urg01", "Q-urg02", nu]);
		});
	});
	test("a hold with no --item, an unknown item or an answered item is refused and writes nothing", () => {
		const d = scratch();
		const none = afk(d, "hold", "Billing", "approve the invoice migration");
		expect(none.status).toBe(2);
		expect(none.stderr).toContain("a hold needs --item");
		expect(none.stderr).toContain("ask.ts");
		const unknown = afk(d, "hold", "Billing", "approve the invoice migration", "--item", "Q-nope1");
		expect(unknown.status).toBe(2);
		expect(unknown.stderr).toContain("Q-nope1 is not on the decision queue");
		const q = idOf(ask(d, { urgent: false, title: "Docs site rename", notSettled: "docs only" }));
		settle(d, q);
		const done = afk(d, "hold", "Docs", "waits", "--item", q, "--not-settled", "still waiting");
		expect(done.status).toBe(2);
		expect(done.stderr).toContain("already answered");
		expect(withStore(d, heldOpen)).toEqual([]);
	});
	test("a hold on an open question is written with its item", () => {
		const d = scratch();
		const q = idOf(ask(d, { urgent: false, title: "Approve the invoice migration" }));
		expect(afk(d, "hold", "Billing", "approve the invoice migration", "left it parked", "--item", q).status).toBe(0);
		expect(withStore(d, heldOpen).map((h) => h.item)).toEqual([q]);
	});
});

describe("(b) what is already settled is refused, unless given a reason", () => {
	test("ask.ts refuses a settled question with exit 2 and what it matched on, and records nothing", () => {
		const d = scratch();
		settle(d, idOf(ask(d, { urgent: false, title: "Rename the project to Atlas" })));
		const r = ask(d, { urgent: false, title: "Rename to Atlas?" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("already settled");
		expect(r.stderr).toContain('answered "No"');
		expect(r.stderr).toContain("matched on title overlap");
		expect(r.stderr).toContain('"notSettled"');
		expect(withStore(d, (s) => questionStates(s).size)).toBe(1);
	});
	test("notSettled overrides, and the reason is stored on the question", () => {
		const d = scratch();
		settle(d, idOf(ask(d, { urgent: false, title: "Rename the project to Atlas" })));
		const r = ask(d, {
			urgent: false,
			title: "Rename to Atlas? (docs site)",
			notSettled: "the docs site, not the product",
		});
		expect(r.status).toBe(0);
		expect(withStore(d, (s) => getQuestion(s, idOf(r))!.notSettled)).toBe("the docs site, not the product");
	});
	test("the decision log and a ruling settle a question too", () => {
		const d = scratch();
		withStore(d, (s) =>
			s.decisions.append({
				t: "2026-11-05T12:00:00.000Z",
				thread: "x",
				decision: "Pinned the queue worker to two replicas",
				ruling: "R3",
				ref: null,
			}),
		);
		const r = ask(d, { urgent: false, title: "Queue worker replicas pinned to two?" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("decision | 2026-11-05");
	});
	test("afk.ts hold refuses a settled wait; --not-settled overrides and is stored; a question's own reason is inherited", () => {
		const d = scratch();
		settle(d, idOf(ask(d, { urgent: false, title: "Rename the project to Atlas" })));
		const open = idOf(ask(d, { urgent: false, title: "Logo colour for the launch", notSettled: undefined }));
		const refused = afk(d, "hold", "Brand", "Rename to Atlas?", "--item", open);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("matched on title overlap");
		expect(refused.stderr).toContain("--not-settled");
		expect(afk(d, "hold", "Brand", "Rename to Atlas?", "--item", open, "--not-settled", "the docs site").status).toBe(
			0,
		);
		const inherit = idOf(
			ask(d, { urgent: false, title: "Rename to Atlas? (docs site)", notSettled: "docs site, not the product" }),
		);
		expect(afk(d, "hold", "Docs", "Rename to Atlas? on the docs site", "--item", inherit).status).toBe(0);
		expect(withStore(d, heldOpen).map((h) => h.notSettled)).toEqual([
			"the docs site",
			`inherited from ${inherit}: docs site, not the product`,
		]);
		expect(afk(d, "hold", "Brand", "x", "--item", open, "--not-settled", "  ").status).toBe(2);
	});
});
