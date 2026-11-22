import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuilderReservations } from "./builder-reservations.ts";

const dirs: string[] = [];
function state(): string {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-builders-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const first = () => ({ plan: "first", scope: "host-a/environment/project" });

test("a pending request holds capacity after reopening and replays its original plan", () => {
	const dir = state();
	const store = new BuilderReservations<string>(dir);
	const firstAttempt = store.reserve("request", "worker/project", first);
	expect(firstAttempt.acquired).toBe(true);
	const reopened = new BuilderReservations<string>(dir);
	const retry = reopened.reserve("request", "worker/project", () => {
		throw Error("a pending request cannot be replanned");
	});
	expect(retry).toEqual({ acquired: false, reservation: firstAttempt.reservation });
	expect(reopened.preview((held) => held.map((entry) => entry.plan))).toEqual(["first"]);
	expect(() => reopened.get("request", "steward/project")).toThrow("already bound");
	expect(() => reopened.reserve("request", "worker/other", first)).toThrow("already bound");
});

test("confirmed reservations reconcile only against matching scopes and fence stale snapshots", () => {
	const store = new BuilderReservations<string>(state());
	const { reservation } = store.reserve("request", "worker/project", first);
	store.complete("request", reservation.attemptId, "thread");
	const probe = (scope: string, snapshotStartedAt: number) => ({
		observed: new Map([[scope, new Set(["thread"])]]),
		snapshotStartedAt,
	});
	const sameScope = probe(reservation.scope, Date.now());
	const wrongScope = probe("host-b/environment/project", Date.now());
	const heldIds = (rows: readonly { requestId: string }[]) => rows.map((row) => row.requestId);
	expect(store.preview(heldIds, wrongScope)).toEqual(["request"]);
	expect(store.preview(heldIds, sameScope)).toEqual([]);
	expect(store.preview(heldIds, { ...wrongScope, snapshotStartedAt: Date.now() + 1_000 })).toEqual(["request"]);
	// A failed placement still reconciles confirmations independently of the request being planned.
	expect(() =>
		store.reserve(
			"another-request",
			"worker/project",
			() => {
				throw Error("no qualified builder");
			},
			sameScope,
		),
	).toThrow("no qualified builder");
	expect(store.preview(heldIds, { ...wrongScope, snapshotStartedAt: 1 })).toEqual(["request"]);
	expect(store.preview(heldIds, { ...wrongScope, snapshotStartedAt: Date.now() + 1_000 })).toEqual([]);
	expect(store.get("request", "worker/project")).toMatchObject({ status: "confirmed", threadId: "thread" });
});

test("a definite failure frees capacity and an old attempt cannot settle its replacement", () => {
	const store = new BuilderReservations<string>(state());
	const firstAttempt = store.reserve("request", "worker/project", first).reservation;
	store.release("request", firstAttempt.attemptId);
	expect(store.get("request", "worker/project")).toMatchObject({ status: "released", plan: "first" });
	expect(store.preview((held) => held)).toEqual([]);
	const retry = store.reserve("request", "worker/project", () => ({ ...first(), plan: "replacement" }));
	expect(retry).toMatchObject({ acquired: true, reservation: { plan: "replacement", status: "pending" } });
	expect(() => store.complete("request", firstAttempt.attemptId, "wrong")).toThrow("matching launch reservation");
	expect(() => store.release("request", firstAttempt.attemptId)).toThrow("matching unconfirmed launch reservation");
	store.complete("request", retry.reservation.attemptId, "real");
	store.complete("request", retry.reservation.attemptId, "real");
	expect(() => store.release("request", retry.reservation.attemptId)).toThrow(
		"matching unconfirmed launch reservation",
	);
});

test("preview of a fresh state directory leaves it empty", () => {
	const dir = state();
	const store = new BuilderReservations<string>(dir);
	expect(store.get("request", "worker/project")).toBeUndefined();
	expect(store.preview((held) => ({ count: held.length }))).toEqual({ count: 0 });
	expect(readdirSync(dir)).toEqual([]);
});

test("concurrent processes claim the same request once and then reserve against each other's load", async () => {
	const dir = state();
	async function reserve(requestId: string) {
		const script = `
			import { BuilderReservations } from ${JSON.stringify(new URL("./builder-reservations.ts", import.meta.url).pathname)};
			const store = new BuilderReservations(${JSON.stringify(dir)});
			const result = store.reserve(${JSON.stringify(requestId)}, "worker/project", rows => ({
				plan: rows.length, scope: "host/environment/project",
			}));
			console.log(JSON.stringify({ acquired: result.acquired, plan: result.reservation.plan }));
		`;
		const process = Bun.spawn([Bun.which("bun") ?? "bun", "--eval", script], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		if (code !== 0) throw Error(stderr);
		return JSON.parse(stdout) as { acquired: boolean; plan: number };
	}
	const same = await Promise.all([reserve("same"), reserve("same")]);
	expect(same.map((result) => result.acquired).sort()).toEqual([false, true]);
	expect(same.map((result) => result.plan)).toEqual([0, 0]);
	const different = await Promise.all([reserve("different-a"), reserve("different-b")]);
	expect(different.map((result) => result.plan).sort()).toEqual([1, 2]);
});
