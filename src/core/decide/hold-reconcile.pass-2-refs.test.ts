/** hold-reconcile, continued: see hold-reconcile.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { facts, fakeGh, hold, machine, NOW, run, whats } from "../../testing/core-hold-reconcile-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { type Held, heldId } from "../ops/afk-held.ts";
import { BACKOFF_MS, REF_PASS_MS, refsOf } from "./hold-reconcile.ts";
import { classifyThread, takeSnapshots, threadViewAcross } from "./hold-threads.ts";

describe("pass 2: refs", () => {
	test("a rate-limit answer stops the pass and no GitHub call is made until the back-off ends", async () => {
		const store = memStore();
		hold(store, { thread: "a", ref: { pr: "o/r#1" } });
		hold(store, { thread: "b", ref: { pr: "o/r#2" } });
		const limited = fakeGh({
			"repos/o/r/pulls/1": Error("API rate limit exceeded"),
			"repos/o/r/pulls/2": { state: "closed", merged_at: "2026-11-13T12:00:00Z" },
		});
		expect(await run(store, limited.gh)).toMatchObject({ closed: 0, lookups: 1, errors: 1, backoff: true });
		const during = fakeGh({ "repos/o/r/pulls/1": { state: "open" }, "repos/o/r/pulls/2": { state: "open" } });
		await run(store, during.gh, undefined, NOW + REF_PASS_MS);
		expect(during.calls).toEqual([]);
		const after = fakeGh({
			"repos/o/r/pulls/1": { state: "open" },
			"repos/o/r/pulls/2": { state: "closed", merged_at: "2026-11-13T12:00:00Z" },
		});
		expect((await run(store, after.gh, undefined, NOW + BACKOFF_MS + REF_PASS_MS)).closed).toBe(1);
	});

	test("refs are shaped before they reach a request", () => {
		const h = (ref: unknown): Held => ({ t: "t", thread: "x", what: "y", ref: ref as never });
		expect(refsOf(h({ pr: "a/b#1", issue: "a/b#2", branch: "a/b:c/d", threadId: "th-1" })).map((r) => r.key)).toEqual([
			"pr:a/b#1",
			"issue:a/b#2",
			"branch:a/b:c/d",
			"thread::th-1",
		]);
		expect(refsOf(h({ pr: "a/b#1?x=1", issue: "../../x#1", branch: "a/b:$(id)", threadId: "a b" }))).toEqual([]);
		expect(heldId(h({ pr: "a/b#1" }))).toBe(heldId(h(undefined)));
	});

	test("a thread's state: archived is gone, settled with nothing pending is settled, a card or approval pending keeps it live", () => {
		const t = facts({ settled: true });
		expect(classifyThread(t)).toEqual({ state: "settled", saw: "settled" });
		expect(classifyThread({ ...t, archived: true })).toEqual({ state: "gone", saw: "archived" });
		expect(classifyThread({ ...t, pendingRequestId: "r1" })).toEqual({ state: "live" });
		expect(classifyThread({ ...t, status: "waiting" })).toEqual({ state: "live" });
		expect(classifyThread({ ...t, settled: false })).toEqual({ state: "live" });
	});

	// Fix 1. Must fail on 2845f33: the watcher's cached table said "settled" for a thread on an offline server, and the hold closed.
	test("fix 1: a server that is offline, unreachable or partial settles and removes nothing, even if a cache says settled", async () => {
		const store = memStore();
		hold(store, { thread: "on-the-second", ref: { threadId: "th-2" } });
		hold(store, { thread: "on-the-main", ref: { threadId: "th-1" } });
		const snaps = () =>
			takeSnapshots([
				{
					name: "main",
					fetch: async () => ({ complete: true, threads: [{ id: "th-1", ...facts({ settled: true }) }] }),
				},
				{
					name: "second",
					fetch: async () => {
						throw Error("connect ECONNREFUSED");
					},
				},
			]);
		const r = await run(store, undefined, snaps);
		expect(r.closed).toBe(1);
		expect(whats(store)).toEqual(["on-the-second"]);
	});

	test("fix 1: an unhealthy or incomplete snapshot, an adapter with no snapshot, or no snapshot at all, leaves every thread unknown", async () => {
		const settled = { "th-1": facts({ settled: true }), "th-2": facts({ archived: true }) };
		expect(threadViewAcross([machine("m", settled, { healthy: false })], "th-1")).toEqual({ state: "unknown" });
		expect(threadViewAcross([machine("m", settled, { complete: false })], "th-2")).toEqual({ state: "unknown" });
		expect(threadViewAcross([machine("m", {}, { healthy: false })], "th-gone")).toEqual({ state: "unknown" });
		expect(threadViewAcross([], "th-1")).toEqual({ state: "unknown" });
		const [partial] = await takeSnapshots([
			{ name: "m", fetch: async () => ({ complete: false, threads: [{ id: "th-1", ...facts({ settled: true }) }] }) },
		]);
		expect(partial).toMatchObject({ healthy: true, complete: false });
		const store = memStore();
		hold(store, { thread: "h", ref: { threadId: "th-1" } });
		expect(
			(
				await run(store, undefined, async () => {
					throw Error("fetch failed");
				})
			).closed,
		).toBe(0);
		expect(whats(store)).toEqual(["h"]);
	});

	// a thread on an offline server read as gone because another server's snapshot lacked it.
	test("fix 1: a thread is gone only when its OWN server is named and that server's fresh, complete snapshot lacks it", () => {
		const a = machine("main", { "th-1": facts() });
		const second = machine("second", {}, { healthy: false, complete: false });
		expect(threadViewAcross([a, second], "th-on-second")).toEqual({ state: "unknown" });
		expect(threadViewAcross([a, second], "th-on-second", "second")).toEqual({ state: "unknown" });
		expect(threadViewAcross([a], "th-on-second", "second")).toEqual({ state: "unknown" });
		expect(threadViewAcross([a, machine("third", {})], "th-x")).toEqual({ state: "unknown" });
		expect(threadViewAcross([a, second], "th-x", "main")).toEqual({
			state: "gone",
			saw: "gone from main's fresh snapshot",
		});
		expect(threadViewAcross([machine("main", {}, { complete: false })], "th-x", "main")).toEqual({ state: "unknown" });
		expect(threadViewAcross([machine("a", { "th-1": facts({ settled: true }) }), second], "th-1")).toEqual({
			state: "settled",
			saw: "settled",
		});
		expect(
			threadViewAcross(
				[machine("a", { "th-1": facts() }), machine("b", { "th-1": facts({ archived: true }) })],
				"th-1",
			),
		).toEqual({ state: "unknown" });
	});

	test("a hold that names no server stays unknown when any snapshot that answered has an unreadable record or is incomplete", async () => {
		// The laptop lists th-1 archived; the server lists th-1 too, but that record cannot be read.
		const [laptop, server] = await takeSnapshots([
			{
				name: "laptop",
				fetch: async () => ({ complete: true, threads: [{ id: "th-1", ...facts({ archived: true }) }] }),
			},
			{
				name: "server",
				fetch: async () => ({
					complete: true,
					threads: [{ id: "th-1", ...facts(), pendingRequestId: {} } as never, { id: "th-9", ...facts() }],
				}),
			},
		]);
		expect(server).toMatchObject({ healthy: true, complete: true, partial: true });
		expect(threadViewAcross([laptop!, server!], "th-1")).toEqual({ state: "unknown" });
		// An incomplete snapshot that answered could hold the copy too.
		expect(threadViewAcross([laptop!, machine("server", {}, { complete: false })], "th-1")).toEqual({
			state: "unknown",
		});
		// Named server: a readable record still counts; absence from a snapshot with an unreadable record does not.
		expect(threadViewAcross([laptop!, server!], "th-9", "server")).toEqual({ state: "live" });
		expect(threadViewAcross([laptop!, server!], "th-gone", "server")).toEqual({ state: "unknown" });
		expect(threadViewAcross([laptop!, server!], "th-1", "laptop")).toEqual({ state: "gone", saw: "archived" });
		// Through the pass: the server-less hold stays open.
		const store = memStore();
		hold(store, { thread: "unnamed", ref: { threadId: "th-1" } });
		expect((await run(store, undefined, async () => [laptop!, server!])).closed).toBe(0);
		expect(whats(store)).toEqual(["unnamed"]);
	});

	test("fix 1: the ledger closes a missing thread only for a hold that names its server", async () => {
		const store = memStore();
		hold(store, { thread: "named", server: "main", ref: { threadId: "th-del" } });
		hold(store, { thread: "unnamed", ref: { threadId: "th-del" } });
		hold(store, { thread: "on-second", server: "second", ref: { threadId: "th-2" } });
		const snaps = async () => [machine("main", {}), machine("second", {}, { healthy: false, complete: false })];
		expect((await run(store, undefined, snaps)).closed).toBe(1);
		expect(whats(store)).toEqual(["on-second", "unnamed"]);
	});

	test("an issue closed without a closing time, an unreadable repository identity and a renamed repository leave the hold open", async () => {
		const store = memStore();
		hold(store, { thread: "no-time", ref: { issue: "o/r#20" } });
		hold(store, { thread: "bad-id", ref: { branch: "p/q:feat/a" } });
		hold(store, { thread: "renamed", ref: { branch: "s/t:feat/b" } });
		const g = fakeGh({
			"repos/o/r/issues/20": { state: "closed", closed_at: null, pr: false },
			"repos/p/q": { id: "7", full_name: "p/q" },
			"repos/s/t": { id: 8, full_name: "other/name" },
		});
		const out = await run(store, g.gh);
		expect(out).toMatchObject({ ran: true, closed: 0, lookups: 3, errors: 0 });
		expect(g.calls).toEqual(["repos/o/r/issues/20", "repos/p/q", "repos/s/t"]);
		expect(whats(store)).toEqual(["bad-id", "no-time", "renamed"]);
	});

	// Fix 2. Must fail on 2845f33: the slug alone answered "branch absent" for a recreated repository, and the hold closed.
	test("fix 2: a branch is deleted only on the same repository id it was seen on", async () => {
		const path = "repos/o/r/git/matching-refs/heads/feat/x?per_page=100";
		const at = (id: number, count: number, fullName = "o/r") =>
			fakeGh({ "repos/o/r": { id, full_name: fullName }, [path]: count });
		const store = memStore();
		hold(store, { thread: "b", ref: { branch: "o/r:feat/x" } });
		let t = NOW;
		const nextPassAt = () => {
			t += REF_PASS_MS;
			return t;
		};
		const pass = (g: ReturnType<typeof at>) => run(store, g.gh, undefined, nextPassAt());
		await pass(at(77, 1));
		await pass(at(99, 0));
		await pass(at(77, 0, "new-owner/r"));
		await pass(fakeGh({ [path]: 0 }));
		expect(whats(store)).toEqual(["b"]);
		expect((await pass(at(77, 0))).closed).toBe(0);
	});

	// the recorded id was overwritten by the second sighting, so the replay closed the hold.
	test("fix 2: the replay (77,1) then (99,1) then (99,0) does not close, and the recorded id is never rewritten", async () => {
		const path = "repos/o/r/git/matching-refs/heads/feat/x?per_page=100";
		const at = (id: number, count: number) => fakeGh({ "repos/o/r": { id, full_name: "o/r" }, [path]: count });
		const store = memStore();
		hold(store, { thread: "b", ref: { branch: "o/r:feat/x" } });
		let t = NOW;
		const nextPassAt = () => {
			t += REF_PASS_MS;
			return t;
		};
		const pass = (g: ReturnType<typeof at>) => run(store, g.gh, undefined, nextPassAt());
		await pass(at(77, 1));
		await pass(at(99, 1));
		expect((await pass(at(99, 0))).closed).toBe(0);
		expect(whats(store)).toEqual(["b"]);
		expect(
			store.state.get<{ seenLive: Record<string, unknown> }>("hold-reconcile")!.seenLive["o/r:feat/x"],
		).toMatchObject({ repoId: 77, conflict: true });
		expect((await pass(at(77, 0))).closed).toBe(0);
		expect(whats(store)).toEqual(["b"]);
	});

	test("fix 2: a branch seen before the repository id was recorded (old state) is not known deleted", async () => {
		const store = memStore();
		hold(store, { thread: "b", ref: { branch: "o/r:feat/x" } });
		store.state.set("hold-reconcile", { lastPassAt: 0, seenLive: { "o/r:feat/x": 1763000000000 } });
		await run(
			store,
			fakeGh({ "repos/o/r": { id: 77, full_name: "o/r" }, "repos/o/r/git/matching-refs/heads/feat/x?per_page=100": 0 })
				.gh,
		);
		expect(whats(store)).toEqual(["b"]);
	});
});
