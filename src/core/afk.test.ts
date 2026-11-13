import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { appendHeld, brief, briefMarkdown, closeHeld, closeHeldForCard, closeHeldForItem, heldId, heldOpen, mandateLine, readAfk, type Afk, type Held } from "./afk.ts";

const a: Afk = { enteredAt: "2026-11-01T12:45:00.000Z", words: "keep everything moving", expectedReturn: "2026-11-01T20:00:00Z" };

describe("mandateLine", () => {
	test("carries his words, the hold rule and the never-pre-authorized limits", () => {
		const m = mandateLine(a);
		expect(m).toContain("keep everything moving");
		expect(m).toContain("Hold-for-return");
		expect(m).toContain("never pre-authorized");
		expect(m).toContain("Expected back");
	});
});

describe("briefMarkdown", () => {
	test("decisions are this absence, held items are whatever was passed as open", () => {
		const out = briefMarkdown(
			a,
			[
				{ t: "2026-11-01T01:00:00Z", thread: "old", decision: "before", ruling: "x" },
				{ t: "2026-11-01T13:00:00Z", thread: "T1", decision: "chose local route", ruling: "documented path" },
			],
			[{ t: "2026-11-01T13:05:00Z", thread: "T3", what: "approve flush of test db", taken: "left it parked" }],
			[{ event: "fire" }, { event: "fire" }, { event: "skip-empty-wait" }, { event: "held-by-daemon" }, { event: "alarm" }],
		);
		expect(out.indexOf("Waiting on the operator (1)")).toBeLessThan(out.indexOf("Decided for the operator (1)"));
		expect(out).toContain("approve flush of test db — meanwhile: left it parked");
		expect(out).toContain("chose local route");
		expect(out).not.toContain("before");
		expect(out).toContain("2 wakes sent, 2 handled in code, 0 wakes stuck undelivered for over a day, 1 alarms");
	});
	test("an empty night says nothing waits", () => {
		const out = briefMarkdown(a, [], [], []);
		expect(out).toContain("Waiting on the operator (0):\n- nothing");
		expect(out).toContain("Decided for the operator (0):\n- nothing");
	});
});

describe("the held list", () => {
	const old: Held = { t: "2026-11-01T01:00:00.000Z", thread: "A", what: "from an earlier absence" };
	const fresh: Held = { t: "2026-11-05T09:00:00.000Z", thread: "B", what: "from this absence" };
	const hold = (store: ReturnType<typeof memStore>, h: Held) => appendHeld(store, (({ t: _t, ...rest }) => rest)(h), new Date(h.t));
	test("an open item outlives the absence it was held in", () => {
		const store = memStore();
		hold(store, old); hold(store, fresh);
		expect(heldOpen(store).map((h) => h.thread)).toEqual(["A", "B"]);
		expect(briefMarkdown(a, [], heldOpen(store), [])).toContain("from an earlier absence");
	});
	test("a hold is an item of source held, and its handle is the item's key", () => {
		const store = memStore();
		const id = hold(store, { ...old, item: "Q-abc12" });
		expect(id).toBe(heldId(old));
		expect(store.items.get("held", id)).toMatchObject({ kind: "hold", mode: "silenced", status: "triggered", subject: { kind: "question", id: "Q-abc12" }, payload: { thread: "A" } });
	});
	test("ids stay stable and differ per entry", () => {
		expect(heldId(old)).toBe(heldId({ ...old, taken: "later note" }));
		expect(heldId(old)).not.toBe(heldId(fresh));
		expect(heldId({ ...old, requestId: "r1" })).not.toBe(heldId({ ...old, requestId: "r2" }));
		expect(heldId({ ...old, thread: "A" })).not.toBe(heldId({ ...old, thread: "Z" }));
	});
	test("closeHeld resolves exactly one item and refuses an unknown or already closed id", () => {
		const store = memStore();
		hold(store, old); hold(store, fresh);
		expect(closeHeld(store, heldId(old), "answered").thread).toBe("A");
		expect(heldOpen(store).map((h) => h.thread)).toEqual(["B"]);
		expect(store.items.get("held", heldId(old))).toMatchObject({ status: "resolved", payload: { how: "answered" } });
		expect(() => closeHeld(store, heldId(old), "again")).toThrow("no open held item");
		expect(() => closeHeld(store, "ffffffff", "x")).toThrow("no open held item");
	});
});

describe("closeHeldForCard", () => {
	const seed = (entries: Partial<Held>[]) => {
		const store = memStore();
		entries.forEach((e, i) => appendHeld(store, { thread: "T", what: `w${i}`, ...e }, new Date(`2026-11-06T0${i}:00:00.000Z`)));
		return store;
	};
	const open = (store: ReturnType<typeof memStore>) => heldOpen(store).map((h) => h.what);

	test("closes the approval held under that request id", () => {
		const store = seed([{ requestId: "r1" }, { requestId: "r2" }]);
		expect(closeHeldForCard(store, "th", "r1", "answered")).toBe(1);
		expect(open(store)).toEqual(["w1"]);
	});

	test("closes a card held against that thread, and leaves other threads alone", () => {
		const store = seed([{ threadId: "th" }, { threadId: "other" }]);
		expect(closeHeldForCard(store, "th", "r9", "answered")).toBe(1);
		expect(open(store)).toEqual(["w1"]);
	});

	test("a hold with no card link stays open: it is a decision, not a card", () => {
		const store = seed([{ thread: "th" }]);
		expect(closeHeldForCard(store, "th", "r1", "answered")).toBe(0);
		expect(open(store)).toEqual(["w0"]);
	});

	test("closing twice closes nothing the second time", () => {
		const store = seed([{ threadId: "th" }]);
		closeHeldForCard(store, "th", "r1", "answered");
		expect(closeHeldForCard(store, "th", "r1", "answered")).toBe(0);
	});
});

describe("closeHeldForItem", () => {
	test("closes what was held against the question by its link or by its id named in the text, and nothing else", () => {
		const store = memStore();
		appendHeld(store, { thread: "A", what: "waits on the answer", item: "Q-abc12" }, new Date("2026-11-06T01:00:00Z"));
		appendHeld(store, { thread: "B", what: "see Q-abc12 for context" }, new Date("2026-11-06T02:00:00Z"));
		appendHeld(store, { thread: "C", what: "unrelated Q-zzz99" }, new Date("2026-11-06T03:00:00Z"));
		expect(closeHeldForItem(store, "Q-abc12", "answered straight to its thread")).toBe(2);
		expect(heldOpen(store).map((h) => h.thread)).toEqual(["C"]);
		expect(closeHeldForItem(store, "not-an-id", "x")).toBe(0);
	});
});

describe("the away record and the brief", () => {
	test("the record is read from the away table, and the brief counts events with SQL and lists what is held", () => {
		const store = memStore();
		expect(readAfk(store)).toBeUndefined();
		store.away.enter({ enteredAt: "2026-11-01T12:45:00.000Z", words: "keep going" });
		expect(readAfk(store)).toEqual({ enteredAt: "2026-11-01T12:45:00.000Z", words: "keep going" });
		appendHeld(store, { thread: "T3", what: "approve the flush" }, new Date("2026-11-01T13:00:00Z"));
		store.decisions.append({ t: "2026-11-01T14:00:00.000Z", thread: "T1", decision: "chose local", ruling: "R1", ref: null });
		store.events.append({ t: "2026-11-01T13:30:00.000Z", event: "fire" });
		store.events.append({ t: "2026-11-01T10:00:00.000Z", event: "fire" });
		const out = brief(store, readAfk(store)!);
		expect(out).toContain("approve the flush");
		expect(out).toContain("chose local");
		expect(out).toContain("1 wakes sent");
	});
});
