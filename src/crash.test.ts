/**
 * Real crash tests for the one-wake path. Each test kills a real process at a step (CHAMBERLAIN_CRASH_AT makes it
 * SIGKILL itself right after the named step, see src/core/crash.ts), then starts a fresh real process on the same
 * database file and lets its startup pass run:
 * - page path: the dying process is the real src/web/server.ts answering a real HTTP request; the real daemon then relays.
 * - relay path: the real src/daemon.ts sends a row a producer wrote, and dies at each of the relay's steps.
 * Every child runs with HOME, CHAMBERLAIN_CONF and CHAMBERLAIN_STATE in a scratch directory, and wakes go to a local webhook.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CRASH_STEPS } from "./core/crash.ts";
import { obsFor } from "./core/log.ts";
import { reconcileStore } from "./core/obs/ledger.ts";
import { getQuestion } from "./core/questions.ts";
import { readClaim } from "./core/questions-claim.ts";
import { readRulings } from "./core/rulings.ts";
import {
	accepted,
	daemon,
	diedAt,
	outbox,
	registerCrashHooks,
	rows,
	SRC,
	TIMEOUT,
	type World,
	wakes,
	world,
} from "./testing/crash-fixtures.ts";
import { eventRows } from "./testing/obs.ts";

registerCrashHooks();

describe("the crash steps are the ones the code names", () => {
	test("every step in CRASH_STEPS is reached by a crashPoint call in the source, and every call names a listed step", () => {
		// The page's answer path and the relay each span a few modules (web/app*.ts, core/relay*.ts), and every one of them is read.
		const files = ["web/app*.ts", "core/relay*.ts", "core/steward-*.ts"]
			.flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: SRC })])
			.filter((f) => !f.endsWith(".test.ts"));
		const sources = ["core/deliver.ts", "core/crash.ts", ...files]
			.map((f) => readFileSync(`${SRC}${f}`, "utf8"))
			.join("\n");
		const named = [...sources.matchAll(/crashPoint\("([^"]+)"\)/g)].map((m) => m[1]!);
		expect(new Set(named)).toEqual(new Set(CRASH_STEPS));
	});
});

// ---- the page path ------------------------------------------------------------------------------

describe("page path: the real queue server dies answering a real request, and the daemon's relay sends the one wake", () => {
	const ID = "Q-page1",
		DELIVERY = "answer:item:Q-page1";
	const server = [`${SRC}web/server.ts`];
	async function crash(step: string, body: Record<string, unknown> = { choice: 0, note: "go with the photo" }) {
		const w = await world(ID);
		const p = w.spawn(server, step);
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
			body: JSON.stringify(body),
		}).then(
			(x) => x.status,
			() => "connection lost",
		);
		await diedAt(p, step);
		return { w, r };
	}
	/** A fresh page answers again; it writes the wake and sends nothing itself. */
	const answerAgain = async (w: World, choice = 0) => {
		const before = w.events().filter((e) => e.event === "startup-recovered").length;
		const p = w.spawn(server);
		await w.until("the page to start", () => w.events().filter((e) => e.event === "startup-recovered").length > before);
		const host = `127.0.0.1:${w.port}`;
		const status = await fetch(`http://${host}/api/items/${ID}/answer`, {
			method: "POST",
			headers: {
				host,
				"content-type": "application/json",
				"x-decision-queue": "1",
				"x-decision-token": w.key,
				origin: `http://${host}`,
			},
			body: JSON.stringify({ choice }),
		}).then((x) => x.status);
		p.kill();
		await p.exited;
		expect(accepted).toHaveLength(0);
		return status;
	};

	test(
		"before the commit: nothing of the answer exists, nothing is sent, and answering again works once",
		async () => {
			const { w, r } = await crash("before-commit");
			expect(r).toBe("connection lost");
			expect(readClaim(w.store, ID)).toBeUndefined();
			expect(getQuestion(w.store, ID)!.status).toBe("open");
			expect(rows(w, "SELECT 1 FROM claims")).toEqual([]);
			expect(outbox(w)).toEqual([]);
			await daemon(w);
			expect(accepted).toHaveLength(0);
			expect(await answerAgain(w)).toBe(200);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
		},
		TIMEOUT,
	);

	test(
		"before the commit, with a ruling ticked: no ruling exists either, and answering again saves exactly one",
		async () => {
			const { w } = await crash("before-commit", { choice: 0, saveRuling: true });
			expect(readRulings(w.store)).toEqual([]);
			expect(readClaim(w.store, ID)).toBeUndefined();
			expect(await answerAgain(w, 0)).toBe(200);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
		},
		TIMEOUT,
	);

	test(
		"after the commit: the claim, the answer and the pending row are one commit, and the relay sends the one wake",
		async () => {
			const { w, r } = await crash("committed");
			expect(r).toBe("connection lost");
			expect(readClaim(w.store, ID)).toMatchObject({
				owner: "page",
				deliveryId: DELIVERY,
				answer: { label: "Photo first", note: "go with the photo" },
			});
			expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: false });
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 0 }]);
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
			expect(accepted[0]!.message).toContain("note: go with the photo");
			expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: true });
			await daemon(w);
			wakes(ID, DELIVERY);
		},
		TIMEOUT,
	);

	test(
		"killed between the ledger commit and the inline event: the answer's event is missing, and the reconciler repairs it once",
		async () => {
			const { w } = await crash("committed");
			const obs = obsFor(w.store);
			// The question's own event was written when it was asked; the answer's was never reached.
			expect(eventRows(obs, `source_key = 'item:${ID}:asked'`)).toHaveLength(1);
			expect(eventRows(obs, `source_key = 'item:${ID}:answered'`)).toEqual([]);
			expect(reconcileStore(w.store, { graceMs: 0 })).toMatchObject({ emitted: 1 });
			const [row, ...more] = eventRows(obs, `source_key = 'item:${ID}:answered'`);
			expect(more).toEqual([]);
			expect(row).toMatchObject({ event: "question.answered", corr: null });
			expect(JSON.parse(row!.data)).toMatchObject({ item: ID, choice: 0, recommended: true, by: "page", ruled: false });
			// A second pass, and the page answering for real afterwards, add nothing.
			expect(reconcileStore(w.store, { graceMs: 0 })).toMatchObject({ emitted: 0 });
			expect(eventRows(obs, `source_key = 'item:${ID}:answered'`)).toHaveLength(1);
			expect(obs.counters).toEqual({ rejected: 0, redacted: 0, failed: 0, dropped: 0 });
		},
		TIMEOUT,
	);

	test(
		"after the commit, with a ruling ticked: the ruling is in the same commit as the claim, under the id its wake names",
		async () => {
			const { w } = await crash("committed", { choice: 0, saveRuling: true });
			const claim = readClaim(w.store, ID) as { ruling?: { id: string } };
			expect(claim.ruling?.id).toMatch(/^R\d+$/);
			expect(
				readRulings(w.store)
					.filter((x) => x.item === ID)
					.map((x) => [x.id, x.status]),
			).toEqual([[claim.ruling!.id, "in-force"]]);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
			expect(accepted[0]!.message).toContain(`ruling: saved as ${claim.ruling!.id}, in force`);
			expect(readRulings(w.store).filter((x) => x.item === ID)).toHaveLength(1);
		},
		TIMEOUT,
	);
});
