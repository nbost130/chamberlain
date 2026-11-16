import { describe, expect, test } from "bun:test";
import {
	answerOf,
	facts,
	fakeGh,
	hold,
	how,
	machine,
	NOW,
	PR,
	question,
	run,
	whats,
} from "../../testing/core-hold-reconcile-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { askQuestion, notNow, QUEUE } from "../items/questions.ts";
import { claimWake, pageClaim } from "../items/questions-claim.ts";
import { HELD, heldOpen } from "../ops/afk-held.ts";
import { MAX_REQUESTS, REF_PASS_MS, reconcileItemHolds } from "./hold-reconcile.ts";

describe("pass 1: every way a question gets answered closes its holds", () => {
	test("page answer, batch answer, card answer and a direct relay each close their question's holds", () => {
		const store = memStore();
		const ids = ["Q-page1", "Q-batch", "Q-card1", "Q-relay", "Q-open1"];
		for (const id of ids) {
			askQuestion(store, question(id));
			hold(store, { thread: id, item: id });
		}
		claimWake(store, pageClaim(question("Q-page1"), answerOf("Q-page1", "page")));
		claimWake(store, pageClaim(question("Q-batch"), answerOf("Q-batch", "batch")));
		store.items.resolve(QUEUE, "Q-card1", Date.parse("2026-11-13T02:05:00.000Z"), { answeredOnCard: true });
		const relayed = {
			...question("Q-relay"),
			options: [{ label: "Yes", route: "thread" as const, relay: "go" }],
			threadId: "th-1",
		};
		claimWake(store, pageClaim(relayed, answerOf("Q-relay", "page")));
		store.claims.startRelay(QUEUE, "Q-relay");
		store.claims.finishRelay(QUEUE, "Q-relay", { outcome: "delivered" });
		expect(reconcileItemHolds(store)).toEqual({ closed: 4 });
		expect(whats(store)).toEqual(["Q-open1"]);
	});

	test("a question not answered stays: set aside with not-now closes nothing", () => {
		const store = memStore();
		askQuestion(store, question("Q-wait1"));
		hold(store, { thread: "w", item: "Q-wait1" });
		notNow(store, "Q-wait1", "2026-11-13T02:00:00.000Z");
		expect(reconcileItemHolds(store)).toEqual({ closed: 0 });
		expect(whats(store)).toEqual(["w"]);
	});

	test("(c) a hold names its question by its item field only: an ID in its text closes nothing", () => {
		const store = memStore();
		askQuestion(store, question("Q-abcd1"));
		hold(store, { thread: "linked", item: "Q-abcd1" });
		hold(store, { thread: "texted", what: "palette pick, queue item Q-abcd1" });
		hold(store, { thread: "longer", what: "queue item Q-abcd12" });
		claimWake(store, pageClaim(question("Q-abcd1"), answerOf("Q-abcd1", "page", "2099-01-01T00:00:00.000Z")));
		expect(reconcileItemHolds(store)).toEqual({ closed: 1 });
		expect(whats(store)).toEqual(["longer", "texted"]);
	});

	test("a hold that only mentions an old answered question in its text, written after the answer, is about something else", () => {
		const store = memStore();
		askQuestion(store, question("Q-oldd1"));
		claimWake(store, pageClaim(question("Q-oldd1"), answerOf("Q-oldd1", "page", "2020-01-01T00:00:00.000Z")));
		hold(store, { thread: "later", what: "deploy approval; the earlier call was Q-oldd1" });
		hold(store, { thread: "linked-late", item: "Q-oldd1" });
		expect(reconcileItemHolds(store)).toEqual({ closed: 1 });
		expect(whats(store)).toEqual(["later"]);
	});

	test("re-running closes nothing more and changes no closure", () => {
		const store = memStore();
		askQuestion(store, question("Q-once1"));
		const id = hold(store, { thread: "o", item: "Q-once1" });
		claimWake(store, pageClaim(question("Q-once1"), answerOf("Q-once1", "page")));
		expect(reconcileItemHolds(store).closed).toBe(1);
		const first = store.items.get(HELD, id)!;
		expect(reconcileItemHolds(store, new Date(Date.now() + 60_000)).closed).toBe(0);
		expect(store.items.get(HELD, id)).toEqual(first);
		expect(how(store, id)).toContain("closed by the daemon's hold reconciler");
	});

	test("an empty ledger or queue is not an error", () => {
		expect(reconcileItemHolds(memStore())).toEqual({ closed: 0 });
	});
});

describe("pass 2: refs", () => {
	test("a merged PR closes its hold and the closure says what was seen", async () => {
		const store = memStore();
		const id = hold(store, { thread: "pr", ref: { pr: "example-org/app#962" } });
		const r = await run(
			store,
			fakeGh({ [PR]: { state: "closed", merged_at: "2026-11-13T12:50:41Z", closed_at: "2026-11-13T12:50:41Z" } }).gh,
		);
		expect(r).toMatchObject({ ran: true, closed: 1, lookups: 1, errors: 0 });
		expect(heldOpen(store)).toHaveLength(0);
		expect(how(store, id)).toBe(
			"PR example-org/app#962 merged 2026-11-13T12:50Z; closed by the daemon's hold reconciler.",
		);
	});

	test("a PR closed without merging closes its hold too, and an open PR leaves it", async () => {
		const store = memStore();
		hold(store, { thread: "closed", ref: { pr: "o/r#1" } });
		hold(store, { thread: "open", ref: { pr: "o/r#2" } });
		await run(
			store,
			fakeGh({
				"repos/o/r/pulls/1": { state: "closed", merged_at: null, closed_at: "2026-11-13T11:00:00Z" },
				"repos/o/r/pulls/2": { state: "open" },
			}).gh,
		);
		expect(whats(store)).toEqual(["open"]);
	});

	test("a closed issue closes its hold; an open one and a number that is really a PR stay", async () => {
		const store = memStore();
		hold(store, { thread: "done", ref: { issue: "o/r#10" } });
		hold(store, { thread: "open", ref: { issue: "o/r#11" } });
		hold(store, { thread: "is-a-pr", ref: { issue: "o/r#12" } });
		await run(
			store,
			fakeGh({
				"repos/o/r/issues/10": { state: "closed", closed_at: "2026-11-12T09:30:00Z", pr: false },
				"repos/o/r/issues/11": { state: "open", closed_at: null, pr: false },
				"repos/o/r/issues/12": { state: "closed", closed_at: "2026-11-12T09:30:00Z", pr: true },
			}).gh,
		);
		expect(whats(store)).toEqual(["is-a-pr", "open"]);
	});

	test("a remote branch closes its hold only once it was seen to exist and is then gone", async () => {
		const store = memStore();
		const id = hold(store, { thread: "b", ref: { branch: "o/r:feat/x" } });
		const path = "repos/o/r/git/matching-refs/heads/feat/x?per_page=100";
		const REPO = { "repos/o/r": { id: 77, full_name: "o/r" } };
		await run(store, fakeGh({ ...REPO, [path]: 0 }).gh);
		expect(whats(store)).toEqual(["b"]);
		await run(store, fakeGh({ ...REPO, [path]: 1 }).gh, undefined, NOW + REF_PASS_MS);
		expect(whats(store)).toEqual(["b"]);
		expect((await run(store, fakeGh({ ...REPO, [path]: 0 }).gh, undefined, NOW + 2 * REF_PASS_MS)).closed).toBe(1);
		expect(how(store, id)).toMatch(
			/^branch o\/r:feat\/x no longer on the remote \(repo id 77, last seen 2026-11-13T13:10Z\)/,
		);
	});

	test("a thread settled or gone closes its hold; a live or unknown thread leaves it, and a card link counts as a thread ref", async () => {
		const store = memStore();
		hold(store, { thread: "settled", ref: { threadId: "th-settled" } });
		hold(store, { thread: "gone", threadId: "th-gone" });
		hold(store, { thread: "live", ref: { threadId: "th-live" } });
		hold(store, { thread: "unknown", ref: { threadId: "th-unknown" } });
		const snaps = async () => [
			machine("main", {
				"th-settled": facts({ settled: true }),
				"th-gone": facts({ archived: true }),
				"th-live": facts(),
			}),
			machine("second", {}, { healthy: false, complete: false }),
		];
		const r = await run(store, fakeGh({}).gh, snaps);
		expect(r).toMatchObject({ closed: 2, lookups: 0 });
		expect(whats(store)).toEqual(["live", "unknown"]);
	});

	test("an API error, a garbled answer and an unknown state all leave the hold open", async () => {
		const store = memStore();
		hold(store, { thread: "err", ref: { pr: "o/r#1" } });
		hold(store, { thread: "garbled", ref: { pr: "o/r#2" } });
		hold(store, { thread: "weird", ref: { pr: "o/r#3" } });
		hold(store, { thread: "no-ts", ref: { pr: "o/r#4" } });
		hold(store, { thread: "branch-garbled", ref: { branch: "o/r:b" } });
		hold(store, { thread: "issue-garbled", ref: { issue: "o/r#5" } });
		const r = await run(
			store,
			fakeGh({
				"repos/o/r/pulls/1": Error("HTTP 404"),
				"repos/o/r/pulls/2": "<html>",
				"repos/o/r/pulls/3": { state: "locked" },
				"repos/o/r/pulls/4": { state: "closed", merged_at: null, closed_at: null },
				"repos/o/r": { id: 1, full_name: "o/r" },
				"repos/o/r/git/matching-refs/heads/b?per_page=100": "0",
				"repos/o/r/issues/5": null,
			}).gh,
		);
		expect(r).toMatchObject({ closed: 0, errors: 1 });
		expect(heldOpen(store)).toHaveLength(6);
	});

	test("with no GitHub reader, PR refs are never checked and thread refs still are", async () => {
		const store = memStore();
		hold(store, { thread: "pr", ref: { pr: "o/r#1" } });
		hold(store, { thread: "th", ref: { threadId: "th-gone" } });
		const r = await run(store, undefined, async () => [machine("main", { "th-gone": facts({ archived: true }) })]);
		expect(r).toMatchObject({ closed: 1, lookups: 0 });
		expect(whats(store)).toEqual(["pr"]);
	});

	test("holds with no ref, a malformed ref, or only prose are never touched and cost no call", async () => {
		const store = memStore();
		hold(store, { thread: "none", what: "merge PR example-org/app#962 for me" });
		hold(store, {
			thread: "bad",
			ref: { pr: "not a ref", branch: "o/r:b; rm -rf /", issue: "o/r#0", runId: "x" } as never,
		});
		const { gh, calls } = fakeGh({});
		expect(await run(store, gh)).toMatchObject({ ran: true, closed: 0, lookups: 0 });
		expect(calls).toEqual([]);
		expect(whats(store)).toEqual(["bad", "none"]);
	});

	test("a hold with several refs closes when any one is done; a runId alone is never acted on", async () => {
		const store = memStore();
		hold(store, { thread: "two", ref: { pr: "o/r#7", issue: "o/r#8" } });
		hold(store, { thread: "run", ref: { runId: "01JABCDEF" } });
		await run(
			store,
			fakeGh({
				"repos/o/r/pulls/7": { state: "open" },
				"repos/o/r/issues/8": { state: "closed", closed_at: "2026-11-13T10:00:00Z", pr: false },
			}).gh,
		);
		expect(whats(store)).toEqual(["run"]);
	});

	test("one lookup per distinct ref however many holds name it, and all of them close", async () => {
		const store = memStore();
		for (const t of ["a", "b", "c"]) hold(store, { thread: t, ref: { pr: "o/r#962" } });
		const { gh, calls } = fakeGh({ "repos/o/r/pulls/962": { state: "closed", merged_at: "2026-11-13T12:00:00Z" } });
		expect((await run(store, gh)).closed).toBe(3);
		expect(calls).toHaveLength(1);
	});

	test("re-running is idempotent, and the pass is throttled to one per interval", async () => {
		const store = memStore();
		hold(store, { thread: "m", ref: { pr: "o/r#1" } });
		hold(store, { thread: "o", ref: { pr: "o/r#2" } });
		const { gh, calls } = fakeGh({
			"repos/o/r/pulls/1": { state: "closed", merged_at: "2026-11-13T12:00:00Z" },
			"repos/o/r/pulls/2": { state: "open" },
		});
		expect((await run(store, gh)).closed).toBe(1);
		expect(await run(store, gh, undefined, NOW + 60_000)).toEqual({
			ran: false,
			closed: 0,
			lookups: 0,
			requests: 0,
			errors: 0,
		});
		expect((await run(store, gh, undefined, NOW + REF_PASS_MS)).closed).toBe(0);
		expect(calls).toEqual(["repos/o/r/pulls/1", "repos/o/r/pulls/2", "repos/o/r/pulls/2"]);
	});

	test("a pass spends at most MAX_REQUESTS requests and the next pass starts with the refs it skipped", async () => {
		const store = memStore();
		const n = MAX_REQUESTS + 5;
		const table: Record<string, unknown> = {};
		for (let i = 1; i <= n; i++) {
			hold(store, { thread: `h${i}`, ref: { pr: `o/r#${i}` } });
			table[`repos/o/r/pulls/${i}`] = { state: "open" };
		}
		expect(await run(store, fakeGh(table).gh)).toMatchObject({ lookups: MAX_REQUESTS, requests: MAX_REQUESTS });
		const second = fakeGh(table);
		await run(store, second.gh, undefined, NOW + REF_PASS_MS);
		expect(second.calls.slice(0, 5).sort()).toEqual(
			Array.from({ length: 5 }, (_, i) => `repos/o/r/pulls/${MAX_REQUESTS + 1 + i}`).sort(),
		);
	});

	// Fix 4. Must fail on 4f1718e: 31 branch refs reported 30 lookups and made 60 requests.
	test("fix 4: every API request counts against the budget, the repository-identity call too", async () => {
		const store = memStore();
		const table: Record<string, unknown> = {};
		for (let i = 1; i <= 31; i++) {
			hold(store, { thread: `b${i}`, ref: { branch: `o/r${i}:feat/x` } });
			table[`repos/o/r${i}`] = { id: i, full_name: `o/r${i}` };
			table[`repos/o/r${i}/git/matching-refs/heads/feat/x?per_page=100`] = 1;
		}
		const g = fakeGh(table);
		const r = await run(store, g.gh);
		expect(g.calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
		expect(r.requests).toBe(g.calls.length);
		expect(r.lookups).toBe(MAX_REQUESTS / 2);
		const g2 = fakeGh(table);
		await run(store, g2.gh, undefined, NOW + REF_PASS_MS);
		expect(g2.calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
		expect(g2.calls[0]).toBe("repos/o/r16");
	});
});
