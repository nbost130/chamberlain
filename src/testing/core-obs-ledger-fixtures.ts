import { afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appendHeld, closeHeld, heldId } from "../core/afk-held.ts";
import { decisionRecord } from "../core/decided.ts";
import { obsFor } from "../core/log.ts";
import { type Answer, askQuestion, QUEUE, type Question } from "../core/questions.ts";
import { claimWake, pageClaim } from "../core/questions-claim.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath, type Store } from "../core/store.ts";
import { eventRows, OTHER_THREAD, THREAD } from "./obs.ts";
import { MARK } from "./secrets.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreObsLedgerFixtures() {
	const dirs: string[] = [];

	const stores: Store[] = [];

	afterEach(() => {
		for (const s of stores.splice(0)) s.close();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const scratch = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-ledger-`);
		dirs.push(d);
		return d;
	};

	const open = (dir: string) => {
		const s = openStore(dbPath(dir));
		stores.push(s);
		return s;
	};

	const question = (id: string, extra: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Ship ${MARK} to the billing page?`,
		context: `context ${MARK}`,
		options: [{ label: `Yes ${MARK}` }, { label: "No" }, { label: "Later" }],
		recommended: 1,
		thread: `Billing ${MARK}`,
		server: "main",
		threadId: THREAD,
		createdAt: "2026-11-13T00:00:00.000Z",
		...extra,
	});

	const answerOf = (id: string, choice: number, by: "page" | "batch", t: string): Answer => ({
		choice,
		label: `label ${MARK}`,
		note: `a note ${MARK}`,
		by,
		t,
		deliveryId: `answer:item:${id}`,
	});

	/** A ledger the way it was before telemetry existed: rows of every kind, and no obs.db. */
	function oldLedger(dir: string) {
		const store = open(dir);
		askQuestion(store, question("Q-aaaa1"), Date.parse("2026-11-13T00:00:00.000Z"));
		askQuestion(
			store,
			question("Q-bbbb2", { threadId: "not-a-uuid", options: [{ label: "A" }, { label: "B" }] }),
			Date.parse("2026-11-13T00:10:00.000Z"),
		);
		askQuestion(
			store,
			question("Q-cccc3", { secret: true, cardRequest: "req-1" }),
			Date.parse("2026-11-13T00:20:00.000Z"),
		);
		askQuestion(store, question("Q-dddd4"), Date.parse("2026-11-13T00:30:00.000Z"));
		claimWake(store, pageClaim(question("Q-aaaa1"), answerOf("Q-aaaa1", 1, "page", "2026-11-13T01:00:00.000Z")));
		claimWake(store, pageClaim(question("Q-bbbb2"), answerOf("Q-bbbb2", 0, "batch", "2026-11-13T02:00:00.000Z")));
		store.items.resolve(QUEUE, "Q-cccc3", Date.parse("2026-11-13T03:00:00.000Z"), { answeredOnCard: true });
		for (const [i, thread] of [THREAD, "Deploy the billing fix", OTHER_THREAD].entries())
			store.decisions.append(
				decisionRecord(
					{ thread, decision: `decided ${MARK} ${i}`, ruling: i === 0 ? "R12, R30: words" : "no ruling" },
					`2026-11-12T0${i}:00:00.000Z`,
				),
			);
		const h1 = appendHeld(
			store,
			{ thread: "T1", what: `held ${MARK}`, item: "Q-dddd4" },
			new Date("2026-11-13T00:40:00.000Z"),
		);
		const h2 = appendHeld(
			store,
			{ thread: "T2", what: "held two", requestId: "req-9", server: "main" },
			new Date("2026-11-13T00:41:00.000Z"),
		);
		appendHeld(store, { thread: "T3", what: "still open" }, new Date("2026-11-13T00:42:00.000Z"));
		closeHeld(store, h1, "answered", new Date("2026-11-13T05:00:00.000Z"));
		closeHeld(store, h2, "card gone", new Date("2026-11-13T05:30:00.000Z"));
		store.close();
		stores.splice(stores.indexOf(store), 1);
		// What this build wrote inline is not what an old build wrote: remove it, so the reconciler starts from a ledger with no events at all.
		for (const f of readdirSync(dir)) if (f.startsWith("obs.db")) rmSync(`${dir}/${f}`);
		return { h1, h2 };
	}

	const keysOf = (store: Store) =>
		eventRows(obsFor(store), "source_key IS NOT NULL")
			.map((r) => r.source_key as string)
			.sort();

	void heldId;

	return { scratch, open, question, answerOf, oldLedger, keysOf };
}
