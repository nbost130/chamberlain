/**
 * Snooze, direction and dismiss at the store: what each does to the item, its claim, its afk hold and the settled-question lookup.
 * The page's routes are in src/web/queue-actions.test.ts; the daemon's return notice is in src/core/snooze-engine.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import { appendHeld, HELD, heldId, heldOpen } from "./afk.ts";
import { reconcileItemHolds } from "./hold-reconcile.ts";
import {
	answerRoute,
	answerWake,
	askQuestion,
	batchable,
	claimWake,
	DIRECTION_LABEL,
	DISMISSED_LABEL,
	getQuestion,
	pageClaim,
	plainAnswer,
	QUEUE,
	type Question,
	questionStates,
	ranked,
	recordAnswerDelivered,
	snoozed,
} from "./questions.ts";
import { findSettled } from "./settled.ts";
import {
	clearSnooze,
	dueSnoozes,
	parseSnoozeUntil,
	returnDueSnoozes,
	SNOOZE_MAX_MS,
	SNOOZE_MIN_MS,
	snoozeQuestion,
	unsnoozeQuestion,
} from "./snooze.ts";
import { openStore } from "./sqlite-store.ts";
import { dbPath, type Store } from "./store.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Which launch plan do we ship for ${id}`,
	context: "",
	options: [{ label: "Plan A" }, { label: "Plan B" }],
	recommended: 0,
	thread: "Launch thread",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-14T08:00:00.000Z",
	...over,
});
const hold = (store: Store, id: string) =>
	appendHeld(
		store,
		{ thread: "Launch thread", what: `waits on a launch plan for ${id}`, item: id },
		new Date(NOW - HOUR),
	);
const holdNotes = (store: Store, hid: string) =>
	((store.items.get(HELD, hid)?.payload.notes as { text: string }[] | undefined) ?? []).map((n) => n.text);
const stateOf = (store: Store, id: string, now = NOW) => questionStates(store, now).get(id)!;

describe("what a snooze time may be", () => {
	test("an absolute time in the future, up to a year, written back as ISO", () => {
		expect(parseSnoozeUntil(iso(NOW + HOUR), NOW)).toEqual({ ok: true, until: iso(NOW + HOUR) });
		expect(parseSnoozeUntil("2026-11-15T09:00:00-05:00", NOW)).toEqual({ ok: true, until: "2026-11-15T14:00:00.000Z" });
		expect(parseSnoozeUntil(iso(NOW + SNOOZE_MAX_MS), NOW).ok).toBe(true);
	});
	test("nothing else: not text, not a date, not in the past, not within half a minute, not past a year", () => {
		for (const bad of [
			undefined,
			null,
			5,
			{},
			"",
			"  ",
			"tomorrow",
			"2026-13-45",
			iso(NOW - HOUR),
			iso(NOW),
			iso(NOW + SNOOZE_MIN_MS - 1),
		])
			expect([bad, parseSnoozeUntil(bad, NOW).ok]).toEqual([bad, false]);
		expect(parseSnoozeUntil(iso(NOW + SNOOZE_MAX_MS + 1), NOW)).toEqual({
			ok: false,
			error: "until is more than a year away",
		});
		expect(parseSnoozeUntil(iso(NOW + SNOOZE_MIN_MS), NOW).ok).toBe(true);
	});
});

describe("snooze", () => {
	test("takes the item off the active list into the Snoozed one, still open and unanswered, and says when it returns", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		askQuestion(store, question("Q-other"));
		snoozeQuestion(store, "Q-snz1", iso(NOW + 2 * HOUR), NOW);
		const q = stateOf(store, "Q-snz1");
		expect(q.status).toBe("open");
		expect(q.snooze).toEqual({ until: iso(NOW + 2 * HOUR), at: iso(NOW), active: true, returned: false });
		expect(ranked(questionStates(store, NOW).values()).map((i) => i.id)).toEqual(["Q-other"]);
		expect(snoozed(questionStates(store, NOW).values()).map((i) => i.id)).toEqual(["Q-snz1"]);
		// it is not answered: no claim, no wake, nothing batch-accepts it, and it is still a question an answer can settle
		expect(store.claims.get(QUEUE, "Q-snz1")).toBeUndefined();
		expect(batchable(q)).toBe(false);
		expect(batchable(stateOf(store, "Q-other"))).toBe(true);
	});

	test("comes back on the active list by itself the moment its time arrives: nothing runs, nothing is rewritten", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		snoozeQuestion(store, "Q-snz1", iso(NOW + HOUR), NOW);
		const before = JSON.stringify(store.items.get(QUEUE, "Q-snz1"));
		for (const [at, active] of [
			[NOW + 1, true],
			[NOW + HOUR - 1, true],
			[NOW + HOUR, false],
			[NOW + 30 * HOUR, false],
		] as const) {
			const states = questionStates(store, at);
			expect([at - NOW, states.get("Q-snz1")!.snooze?.active]).toEqual([at - NOW, active]);
			expect([at - NOW, ranked(states.values()).map((i) => i.id)]).toEqual([at - NOW, active ? [] : ["Q-snz1"]]);
			expect([at - NOW, snoozed(states.values()).map((i) => i.id)]).toEqual([at - NOW, active ? ["Q-snz1"] : []]);
		}
		expect(JSON.stringify(store.items.get(QUEUE, "Q-snz1"))).toBe(before);
	});

	test("survives a restart: the same snooze from the same database file, and back on the list when its time passes", () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-snooze-`);
		dirs.push(root);
		const first = openStore(dbPath(root));
		askQuestion(first, question("Q-snz1"));
		askQuestion(first, question("Q-keep", { createdAt: "2026-11-14T09:00:00.000Z" }));
		snoozeQuestion(first, "Q-snz1", iso(NOW + HOUR), NOW);
		first.close();
		const second = openStore(dbPath(root));
		expect(stateOf(second, "Q-snz1", NOW + HOUR / 2).snooze).toMatchObject({ until: iso(NOW + HOUR), active: true });
		expect(ranked(questionStates(second, NOW + HOUR / 2).values()).map((i) => i.id)).toEqual(["Q-keep"]);
		expect(ranked(questionStates(second, NOW + HOUR + 1).values()).map((i) => i.id)).toEqual(["Q-snz1", "Q-keep"]);
		// the daemon that comes up after the restart still owes the return, once
		expect(returnDueSnoozes(second, NOW + HOUR + 1).map((i) => i.id)).toEqual(["Q-snz1"]);
		second.close();
		const third = openStore(dbPath(root));
		expect(returnDueSnoozes(third, NOW + 2 * HOUR)).toEqual([]);
		third.close();
	});

	test("snoozing again replaces the earlier time; un-snoozing returns the item at once", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		snoozeQuestion(store, "Q-snz1", iso(NOW + HOUR), NOW);
		snoozeQuestion(store, "Q-snz1", iso(NOW + 5 * HOUR), NOW + 1000);
		expect(stateOf(store, "Q-snz1").snooze?.until).toBe(iso(NOW + 5 * HOUR));
		unsnoozeQuestion(store, "Q-snz1", NOW + 2000);
		expect(stateOf(store, "Q-snz1").snooze).toBeUndefined();
		expect(ranked(questionStates(store, NOW + 2000).values()).map((i) => i.id)).toEqual(["Q-snz1"]);
		expect(snoozed(questionStates(store, NOW + 2000).values())).toEqual([]);
	});

	test("its afk hold stays open, with a note of the return time, and every other hold is untouched", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		askQuestion(store, question("Q-other"));
		const mine = hold(store, "Q-snz1");
		const theirs = hold(store, "Q-other");
		snoozeQuestion(store, "Q-snz1", iso(NOW + 3 * HOUR), NOW);
		expect(reconcileItemHolds(store, new Date(NOW + 1)).closed).toBe(0);
		expect(heldOpen(store)).toHaveLength(2);
		expect(holdNotes(store, mine)).toHaveLength(1);
		expect(holdNotes(store, mine)[0]).toContain("2026-11-14T15:00Z");
		expect(holdNotes(store, mine)[0]).toContain("stays open");
		expect(holdNotes(store, theirs)).toEqual([]);
		unsnoozeQuestion(store, "Q-snz1", NOW + 5000);
		expect(holdNotes(store, mine)[1]).toContain("Un-snoozed");
		expect(heldOpen(store)).toHaveLength(2);
	});
});

describe("the return", () => {
	test("is due only once the time has passed, is handed back once, and tells the hold", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		askQuestion(store, question("Q-other"));
		const h = hold(store, "Q-snz1");
		snoozeQuestion(store, "Q-snz1", iso(NOW + HOUR), NOW);
		expect(dueSnoozes(store, NOW + HOUR - 1)).toEqual([]);
		expect(returnDueSnoozes(store, NOW + HOUR - 1)).toEqual([]);
		expect(returnDueSnoozes(store, NOW + HOUR).map((i) => i.id)).toEqual(["Q-snz1"]);
		expect(returnDueSnoozes(store, NOW + 2 * HOUR)).toEqual([]);
		expect(stateOf(store, "Q-snz1", NOW + 2 * HOUR).snooze).toMatchObject({ active: false, returned: true });
		expect(holdNotes(store, h).at(-1)).toContain("back on the active list");
		expect(heldOpen(store).map((x) => heldId(x))).toContain(h);
	});
	test("a snooze set again after a return is due again at its own time", () => {
		const store = memStore();
		askQuestion(store, question("Q-snz1"));
		snoozeQuestion(store, "Q-snz1", iso(NOW + HOUR), NOW);
		expect(returnDueSnoozes(store, NOW + HOUR)).toHaveLength(1);
		snoozeQuestion(store, "Q-snz1", iso(NOW + 4 * HOUR), NOW + 2 * HOUR);
		expect(returnDueSnoozes(store, NOW + 3 * HOUR)).toEqual([]);
		expect(returnDueSnoozes(store, NOW + 4 * HOUR)).toHaveLength(1);
	});
	test("an item that was un-snoozed, answered or cleared is never due", () => {
		const store = memStore();
		for (const id of ["Q-unsn", "Q-answ", "Q-clrd"]) {
			askQuestion(store, question(id));
			snoozeQuestion(store, id, iso(NOW + HOUR), NOW);
		}
		unsnoozeQuestion(store, "Q-unsn", NOW + 1);
		claimWake(store, pageClaim(question("Q-answ"), plainAnswer("direction", "Q-answ", "go with A", iso(NOW))));
		clearSnooze(store, "Q-clrd");
		expect(dueSnoozes(store, NOW + 5 * HOUR)).toEqual([]);
	});
});

describe("direction: a note and no option", () => {
	test("is an answer the Steward reads: its wake names the item, says no option was chosen and carries the note", () => {
		const store = memStore();
		const q = question("Q-dir01");
		askQuestion(store, q);
		const a = plainAnswer("direction", q.id, "Do plan A, but skip the migration", iso(NOW));
		expect(a).toMatchObject({
			choice: -1,
			label: DIRECTION_LABEL,
			kind: "direction",
			deliveryId: "answer:item:Q-dir01",
		});
		const claim = pageClaim(q, a);
		expect(claimWake(store, claim).won).toBe(true);
		const wake = claim.message;
		expect(wake.startsWith("[chamberlain] answer:")).toBe(true);
		expect(wake).toContain("Q-dir01");
		expect(wake).toContain("direction, no option chosen");
		expect(wake).toContain("note: Do plan A, but skip the migration");
		expect(wake).toContain("never straight to the thread");
		expect(wake).not.toContain("choice: 1.");
		const s = stateOf(store, q.id);
		expect(s.status).toBe("answered");
		expect(s.answer).toMatchObject({ kind: "direction", note: "Do plan A, but skip the migration" });
		expect(s.dismissal).toBeUndefined();
	});
	test("never takes the direct thread relay, even when every option routes to the thread", () => {
		const q = question("Q-dir02", {
			options: [
				{ label: "Plan A", route: "thread", relay: "do A" },
				{ label: "Plan B", route: "thread", relay: "do B" },
			],
		});
		const a = plainAnswer("direction", q.id, "a note", iso(NOW));
		expect(answerRoute(q, a)).toEqual({ direct: false });
		const claim = pageClaim(q, a);
		expect(claim.relay).toBeUndefined();
		// control: the same item answered with one of its options does go straight to the thread
		const picked = pageClaim(q, { choice: 0, label: "Plan A", by: "page", t: iso(NOW), deliveryId: a.deliveryId });
		expect(picked.relay).toBeDefined();
	});
	test("closes its hold, like any answer", () => {
		const store = memStore();
		askQuestion(store, question("Q-dir03"));
		const h = hold(store, "Q-dir03");
		claimWake(store, pageClaim(question("Q-dir03"), plainAnswer("direction", "Q-dir03", "go", iso(NOW))));
		expect(reconcileItemHolds(store, new Date(NOW + 1)).closed).toBe(1);
		expect(heldOpen(store)).toEqual([]);
		expect(String(store.items.get(HELD, h)?.payload.how)).toContain("direction, no option chosen");
	});
	test("counts as an answer to a settled-question lookup, with its note", () => {
		const store = memStore();
		const q = question("Q-dir04", { title: "Whether the billing retry runs hourly or daily" });
		askQuestion(store, q);
		claimWake(store, pageClaim(q, plainAnswer("direction", q.id, "daily, and page me on failure", iso(NOW))));
		const { matches } = findSettled(store, { title: q.title, thread: q.thread }, {});
		expect(matches).toHaveLength(1);
		expect(matches[0]!.answer).toContain("direction, no option chosen");
		expect(matches[0]!.answer).toContain("daily, and page me on failure");
	});
});

describe("dismiss: already handled, or no longer needed", () => {
	const dismissed = (store: Store, id: string, note?: string) => {
		const q = question(id, { title: "Whether the billing retry runs hourly or daily" });
		askQuestion(store, q);
		const claim = pageClaim(q, plainAnswer("dismissed", id, note, iso(NOW)));
		expect(claimWake(store, claim).won).toBe(true);
		return { q, claim };
	};
	test("is recorded as dismissed, never as an answer: no `answer`, a `dismissal` with the note", () => {
		const store = memStore();
		dismissed(store, "Q-dis01", "already done in the thread");
		const s = stateOf(store, "Q-dis01");
		expect(s.status).toBe("dismissed");
		expect(s.answer).toBeUndefined();
		expect(s.dismissal).toEqual({ note: "already done in the thread", t: iso(NOW) });
		expect(ranked(questionStates(store).values())).toEqual([]);
		expect(plainAnswer("dismissed", "Q-dis01", undefined, iso(NOW))).toMatchObject({
			label: DISMISSED_LABEL,
			choice: -1,
		});
		expect(getQuestion(store, "Q-dis01")?.status).toBe("dismissed");
	});
	test("sends the Steward a short wake that says dismissed, not answered, and carries the note, or says there is none", () => {
		const store = memStore();
		const { claim } = dismissed(store, "Q-dis02", "no longer needed");
		expect(claim.message.startsWith("[chamberlain] answer:")).toBe(true);
		expect(claim.message).toContain("dismissed decision-queue item Q-dis02");
		expect(claim.message).toContain("not an answer");
		expect(claim.message).toContain("note: no longer needed");
		expect(claim.message).not.toMatch(/answered decision-queue item/);
		const bare = pageClaim(question("Q-dis03"), plainAnswer("dismissed", "Q-dis03", undefined, iso(NOW)));
		expect(bare.message).toContain("note: none");
		expect(answerWake(question("Q-dis03"), bare.answer!)).toBe(bare.message);
	});
	test("closes its hold, and records that it was dismissed", () => {
		const store = memStore();
		const h = hold(store, "Q-dis04");
		dismissed(store, "Q-dis04");
		expect(reconcileItemHolds(store, new Date(NOW + 1)).closed).toBe(1);
		expect(heldOpen(store)).toEqual([]);
		expect(String(store.items.get(HELD, h)?.payload.how)).toContain("Dismissed on the queue");
		expect(String(store.items.get(HELD, h)?.payload.how)).not.toContain("Answered");
	});
	test("stays dismissed after its wake is delivered", () => {
		const store = memStore();
		dismissed(store, "Q-dis05");
		recordAnswerDelivered(store, "answer:item:Q-dis05");
		expect(stateOf(store, "Q-dis05")).toMatchObject({ status: "dismissed", delivered: true });
	});
	test("is ignored by settled-question lookups, while an answered question is found", () => {
		const store = memStore();
		const { q } = dismissed(store, "Q-dis06", "handled elsewhere");
		expect(findSettled(store, { title: q.title, thread: q.thread }, {}).matches).toEqual([]);
		expect(findSettled(store, { title: `look at ${q.id}`, item: q.id }, {}).matches).toEqual([]);
		// control: the same question, answered with an option, is settled
		const answered = question("Q-ans01", { title: q.title });
		askQuestion(store, answered);
		claimWake(
			store,
			pageClaim(answered, { choice: 1, label: "Plan B", by: "page", t: iso(NOW), deliveryId: "answer:item:Q-ans01" }),
		);
		const found = findSettled(store, { title: q.title, thread: q.thread }, {}).matches;
		expect(found.map((m) => m.id)).toEqual(["Q-ans01"]);
	});
});
