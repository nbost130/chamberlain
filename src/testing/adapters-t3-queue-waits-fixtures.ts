import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Delivered } from "../adapters/t3/queue-waits-analysis.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useAdaptersT3QueueWaitsFixtures() {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const T0 = Date.parse("2026-11-11T10:00:00.000Z");

	const at = (sec: number) => T0 + Math.round(sec * 1000);

	const iso = (ms: number) => new Date(ms).toISOString();

	const ev = (o: Record<string, unknown>) => o as unknown as Delivered;

	const delivered = (sec: number, deliveryId: string, extra: Record<string, unknown> = {}, http = 202) =>
		ev({ t: iso(at(sec)), event: "delivered", deliveryId, http, attempt: 1, ...extra });

	/** A small T3 state database: the Steward's runs, plus one run on another thread. */
	function fixtureDb() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-qw-`);
		dirs.push(root);
		const path = `${root}/state.sqlite`;
		const db = new Database(path);
		db.run(
			"create table orchestration_v2_projection_runs (run_id text, thread_id text, ordinal int, status text, requested_at text, completed_at text, payload_json text)",
		);
		let n = 0;
		const run = (thread: string, req: number, start: number | null, done: number | null) =>
			db.run("insert into orchestration_v2_projection_runs values (?,?,?,?,?,?,?)", [
				`r${++n}`,
				thread,
				n,
				done ? "completed" : start ? "running" : "queued",
				iso(at(req)),
				done ? iso(at(done)) : null,
				JSON.stringify({ startedAt: start === null ? null : iso(at(start)) }),
			]);
		return { path, db, run };
	}

	return { at, iso, ev, delivered, fixtureDb };
}
