/** crash, continued: the rights-first and answer-never-held paths. See crash.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { finalSendMessage } from "./core/delivery/deliver.ts";
import { getQuestion } from "./core/items/questions.ts";
import { LEGACY_STAMP } from "./core/steward/rights-sent.ts";
import {
	accepted,
	daemon,
	daemonArgs,
	diedAt,
	outbox,
	registerCrashHooks,
	SRC,
	secret,
	TIMEOUT,
	type World,
	wakes,
	world,
} from "./testing/crash-fixtures.ts";

registerCrashHooks();

// These pin the standalone prerequisite path (`rightsInline` off, the kill switch), whose crash points are the ones they kill.
const LEGACY = { CHAMBERLAIN_RIGHTS_INLINE: "0" };

describe("rights first: the real daemon dies between a Steward row's full-rights wake and the row, and the restart sends each once", () => {
	const ID = "Q-rite1",
		ROW = "legacy:row:1",
		LATER = "legacy:row:2";
	const TEXT =
		"[chamberlain] needs_input: a wake queued before the stamps existed.\nDecision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";
	/** A legacy-stamped Steward row (an upgrade or an import): the relay must send the full rights ahead of it. */
	async function legacyRow() {
		const w = await world(ID);
		secret(`${w.conf}/decision-rights.md`, "The Steward may merge green PRs.");
		w.store.wakes.enqueue({
			deliveryId: ROW,
			message: TEXT,
			queuedAt: Date.now(),
			kind: "needs_input",
			rights: [LEGACY_STAMP],
		});
		return w;
	}
	/** The one prerequisite the relay queued for the row: keyed by the state (`<row>:rights-first:<key>`) and stamped with it, as a full block. */
	const prerequisite = (w: World) => {
		const all = w.store.wakes.rows("all").filter((r) => r.deliveryId.startsWith(`${ROW}:rights-first:`));
		expect(all).toHaveLength(1);
		expect(all[0]!.rights).toHaveLength(1);
		expect(all[0]!.rights![0]!.full).toBe(true);
		return all[0]!;
	};
	/** Exactly one POST of each, the rights first, the row byte for byte as queued, both delivered once, and the record from the prerequisite's stamp. */
	function oneOfEach(w: World) {
		const first = prerequisite(w);
		expect(accepted.map((a) => a.deliveryId)).toEqual([first.deliveryId, ROW]);
		expect(accepted[0]!.message).toContain("Decision rights (standing rules):");
		expect(accepted[0]!.message).toContain("The Steward may merge green PRs.");
		expect(accepted[1]!.message).toBe(finalSendMessage(TEXT, ROW));
		expect(outbox(w)).toEqual([
			{ delivery_id: ROW, status: "delivered", attempts: 1 },
			{ delivery_id: first.deliveryId, status: "delivered", attempts: 1 },
		]);
		const { full: _full, used: _used, ...stamp } = first.rights![0]!;
		expect(w.store.state.get("rights-sent")).toEqual(stamp);
	}
	/** A later row that depends on the rights goes alone: the durable record, not the dead process's memory, shows the Steward holds them. */
	async function laterGoesAlone(w: World) {
		w.store.wakes.enqueue({
			deliveryId: LATER,
			message: "a later wake",
			queuedAt: Date.now(),
			kind: "needs_input",
			rights: [LEGACY_STAMP],
		});
		await daemon(w, () => accepted.length >= 3, LEGACY);
		expect(accepted.map((a) => a.deliveryId).slice(2)).toEqual([LATER]);
		expect(w.store.wakes.rows("all").filter((r) => r.deliveryId.includes(":rights-first:"))).toHaveLength(1);
	}

	test(
		"killed right after the rights-first wake was queued: nothing was sent; the restart sends it, then the row, once each, and writes the record",
		async () => {
			const w = await legacyRow();
			await diedAt(w.spawn(daemonArgs, "rights-first-queued", LEGACY), "rights-first-queued");
			const first = prerequisite(w);
			expect(outbox(w)).toEqual([
				{ delivery_id: ROW, status: "pending", attempts: 0 },
				{ delivery_id: first.deliveryId, status: "pending", attempts: 0 },
			]);
			expect(w.store.state.get("rights-sent")).toBeUndefined();
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length >= 2, LEGACY);
			oneOfEach(w);
			await daemon(w, () => true, LEGACY);
			oneOfEach(w);
			await laterGoesAlone(w);
		},
		TIMEOUT,
	);

	test(
		"killed right after the rights-first wake was delivered, before the row: the record was written with it; the restart sends only the row, once",
		async () => {
			const w = await legacyRow();
			await diedAt(w.spawn(daemonArgs, "delivered", LEGACY), "delivered");
			const first = prerequisite(w);
			expect(outbox(w)).toEqual([
				{ delivery_id: ROW, status: "pending", attempts: 0 },
				{ delivery_id: first.deliveryId, status: "delivered", attempts: 1 },
			]);
			expect(accepted.map((a) => a.deliveryId)).toEqual([first.deliveryId]);
			expect(w.store.state.get("rights-sent")).toMatchObject({ hash: first.rights![0]!.hash });
			await daemon(w, () => accepted.length >= 2, LEGACY);
			oneOfEach(w);
			await daemon(w, () => true, LEGACY);
			oneOfEach(w);
			await laterGoesAlone(w);
		},
		TIMEOUT,
	);
});

// ---- one wake at a time -------------------------------------------------------------------------

/** T3's state database as the gate reads it: one Steward run, in whatever status the test says. */
function stewardDb(path: string, status: string, steward: string) {
	const db = new Database(path);
	db.run(
		"create table if not exists orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, payload_json text)",
	);
	db.run("create table if not exists orchestration_v2_projection_messages (message_id text, payload_json text)");
	db.run(
		"create table if not exists orchestration_v2_projection_runtime_requests (thread_id text, created_at text, resolved_at text)",
	);
	db.run(
		"create table if not exists orchestration_v2_projection_turn_items (thread_id text, type text, updated_at text)",
	);
	db.run("delete from orchestration_v2_projection_runs");
	db.run("insert into orchestration_v2_projection_runs values (?,?,?,?,?)", [
		steward,
		1,
		status,
		"2026-11-11T10:00:00Z",
		JSON.stringify({ startedAt: "2026-11-11T10:00:01Z", userMessageId: "m1" }),
	]);
	db.close();
}

describe("an answer is never held: the real page writes it and the real daemon sends it at once while the Steward is busy", () => {
	const ID = "Q-held1",
		DELIVERY = "answer:item:Q-held1",
		STEWARD = "steward-1";
	test(
		"busy: the answer is sent at once and nothing is held; a restart, busy or idle, sends nothing more",
		async () => {
			const w = await world(ID);
			secret(`${w.conf}/steward-thread`, STEWARD);
			const dbFile = `${w.root}/state.sqlite`;
			const env = { CHAMBERLAIN_T3_STATE_DB: dbFile };
			stewardDb(dbFile, "running", STEWARD);
			const page = w.spawn([`${SRC}web/server.ts`], undefined, env);
			await w.until("the page to start", () => w.events().some((e) => e.event === "startup-recovered"));
			const host = `127.0.0.1:${w.port}`;
			const r = await fetch(`http://${host}/api/items/${ID}/answer`, {
				method: "POST",
				headers: {
					host,
					"content-type": "application/json",
					"x-decision-queue": "1",
					"x-decision-token": w.key,
					origin: `http://${host}`,
				},
				body: JSON.stringify({ choice: 0 }),
			});
			expect(r.status).toBe(200);
			expect(await r.json()).toMatchObject({ recorded: true, wake: "queued" });
			page.kill();
			await page.exited;
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length > 0, env);
			wakes(ID, DELIVERY);
			expect(w.store.wakes.held()).toEqual([]);
			expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: true });
			for (const status of ["running", "completed"]) {
				stewardDb(dbFile, status, STEWARD);
				await daemon(w, () => true, env);
				wakes(ID, DELIVERY);
			}
		},
		TIMEOUT,
	);
});
