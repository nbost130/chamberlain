/**
 * Two processes writing at the same moment must never lose a write. These tests start real processes
 * (src/testing/store-worker.ts) on one database file, release them at the same instant, and count what delivered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore } from "./sqlite-store.ts";

const WORKER = new URL("../testing/store-worker.ts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function race(workers: number, mode: string, n: number) {
	const dir = mkdtempSync(`${tmpdir()}/chamberlain-race-`);
	dirs.push(dir);
	const path = `${dir}/chamberlain.db`;
	openStore(path).close(); // migrated once, so the workers race on writes and not on creation
	const startAt = Date.now() + 1500;
	const procs = Array.from({ length: workers }, (_, i) =>
		Bun.spawn(["bun", WORKER, path, String(i), String(startAt), mode, String(n)], { stdout: "pipe", stderr: "pipe" }),
	);
	const results = await Promise.all(
		procs.map(async (p) => {
			const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
			expect({ exit: await p.exited, err }).toEqual({ exit: 0, err: "" });
			return JSON.parse(out) as { id: string; won?: string[] };
		}),
	);
	return { path, results };
}

describe("concurrent writers on one database file", () => {
	test("four processes lose no write: every counter bump, event, held wake and claim is there", async () => {
		const W = 4,
			N = 60;
		const { path } = await race(W, "writes", N);
		const s = openStore(path);
		try {
			// A read-modify-write that was not one transaction would lose bumps; the count must be exact.
			expect(s.state.get("counter")).toBe(W * N);
			expect(s.events.count({ events: ["tick"] })).toBe(W * N);
			expect(s.wakes.held()).toHaveLength(W * N);
			expect(s.claims.list("queue")).toHaveLength(W * N);
			for (let w = 0; w < W; w++)
				expect(s.events.query({ events: ["tick"] }).filter((e) => e.worker === String(w))).toHaveLength(N);
		} finally {
			s.close();
		}
	}, 60_000);

	test("six processes racing for the same items: exactly one wins each, and the stored claim is the winner's", async () => {
		const W = 6,
			N = 40;
		const { path, results } = await race(W, "claims", N);
		const won = results.flatMap((r) => (r.won ?? []).map((k) => ({ k, by: r.id })));
		expect(won).toHaveLength(N);
		expect(new Set(won.map((w) => w.k)).size).toBe(N);
		const s = openStore(path);
		try {
			for (const w of won)
				expect(s.claims.get("queue", w.k)).toMatchObject({ owner: `w${w.by}`, message: `wake from ${w.by}` });
			expect(s.items.list({ status: "triggered" })).toHaveLength(N);
		} finally {
			s.close();
		}
	}, 60_000);
});
