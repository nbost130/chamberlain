/**
 * Round 2 of the inline view (Nathan, 2026-11-15): a builder's question card answered in place, and the page's other snooze times beside the one-tap
 * Snooze. A card's options are a choice list with one answer button under it, as a question's are (Nathan, 2026-11-17). Run against the in-memory DOM (src/testing/inline-dom.ts); what the server lets the view key do with a card is view-key-cards.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
type Call = { method: string; path: string; body?: any };
const button = (dq: El, text: string) => dq.all((e) => e.tag === "button" && e.textContent === text)[0];
const tap = async (dq: El, text: string) => {
	const b = button(dq, text);
	if (!b) throw Error(`no button "${text}"`);
	for (const fn of b.listeners.click ?? []) await fn();
	await settle();
};
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
/** A snooze choice's button, by its own label (its row also shows when it returns). */
const preset = (dq: El, label: string) => dq.all((e) => e.tag === "button" && e.firstChild.textContent === label)[0];
const tapPreset = async (dq: El, label: string) => {
	for (const fn of preset(dq, label)!.listeners.click ?? []) await fn();
	await settle();
};
const has = (e: El, cls: string) => e.className.split(" ").includes(cls);
const opt = (dq: El, label: string) =>
	dq.all((e) => has(e, "dq-opt") && e.all((x) => x.className === "dq-l")[0]?.textContent === label)[0]!;

const qcard = (over: Record<string, unknown> = {}) => ({
	id: "C-0123456789ab",
	type: "question",
	server: "builder",
	threadId: "bt1",
	threadTitle: "Schema work",
	requestId: "r1",
	header: "Which schema?",
	question: "The importer needs one",
	options: [{ label: "One table", detail: "simplest" }, { label: "People + memberships" }],
	recommended: 1,
	answerable: true,
	sig: "sig-1",
	open: "/open/builder/bt1",
	...over,
});

describe("a builder's question card is answered in place", () => {
	test("its options are a choice list with the recommended one chosen; the answer button posts the choice and the fingerprint, and the card says it is answered", async () => {
		const calls: Call[] = [];
		let cards = [qcard()];
		const dq = run(() => ({ items: [], cards }), {
			src: SRC,
			calls,
			post: () => {
				cards = [];
				return { status: 200, body: { ok: true, choice: "People + memberships" } };
			},
		});
		await settle();
		const row = dq.all((e) => e.className.split(" ").includes("dq-actions"))[0]!;
		expect(row.children.map((b) => b.textContent)).toEqual(["Dismiss", "Open the thread"]);
		expect(opt(dq, "People + memberships").className).toContain("sel");
		expect(opt(dq, "One table").textContent).toBe("One tablesimplest");
		await tap(dq, "People + memberships");
		expect(posts(calls)).toEqual([
			{ method: "POST", path: "/api/cards/C-0123456789ab/answer", body: { choice: 1, sig: "sig-1" } },
		]);
		expect(dq.textContent).toContain("Answered: People + memberships. It goes to its thread.");
		// the answered card stays, saying so, with only its thread link; the queue was read again
		expect(dq.all((e) => has(e, "dq-opt") || has(e, "dq-confirm"))).toEqual([]);
		expect(calls.filter((c) => c.path === "/api/queue").length).toBeGreaterThan(1);
	});
	test("a card that changed since it was shown (409) says so, keeps its buttons, and the view reads the queue again", async () => {
		const calls: Call[] = [];
		const dq = run(() => ({ items: [], cards: [qcard()] }), {
			src: SRC,
			calls,
			post: () => ({ status: 409, body: { error: "the card changed since you saw it: refresh and answer again" } }),
		});
		await settle();
		const before = calls.filter((c) => c.path === "/api/queue").length;
		for (const fn of opt(dq, "One table").listeners.click ?? []) await fn();
		await tap(dq, "One table");
		expect(dq.textContent).toContain("the card changed since you saw it");
		expect(button(dq, "One table")?.disabled).toBe(false);
		expect(opt(dq, "One table").disabled).toBe(false);
		expect(calls.filter((c) => c.path === "/api/queue").length).toBeGreaterThan(before);
	});
	test("an approval, a goal, a secret and a link card get no answer buttons: Dismiss and the thread link only", async () => {
		for (const over of [
			{ type: "approval", command: "rm -rf build" },
			{ type: "goal", command: "Ship it" },
			{ type: "secret", answerable: false, why: "In its thread" },
			{ type: "link", answerable: false, why: "In its thread" },
			{ type: "question", answerable: false, why: "In its thread" },
		]) {
			const calls: Call[] = [];
			const dq = run(() => ({ items: [], cards: [qcard(over)] }), { src: SRC, calls });
			await settle();
			expect([over.type, dq.all((e) => e.tag === "button" && e.className.includes("dq-main")).length]).toEqual([
				over.type,
				0,
			]);
			expect(dq.all((e) => e.tag === "a").map((a) => a.textContent)).toEqual(["Open the thread to answer"]);
			// an approval's or goal's command is still shown exactly, so it can be read; nothing here can approve it
			if ("command" in over)
				expect(dq.all((e) => e.tag === "pre").map((e) => e.textContent)).toEqual([String(over.command)]);
			expect(posts(calls)).toEqual([]);
		}
	});
});

describe("the other snooze times, beside the one-tap Snooze", () => {
	const item = {
		id: "Q-snz2",
		kind: "product",
		title: "Which one?",
		context: "pick",
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		status: "open",
		createdAt: new Date().toISOString(),
	};
	const view = () => {
		const calls: Call[] = [];
		const dq = run(() => ({ items: [item] }), {
			src: SRC,
			calls,
			post: (_p, body) => ({ status: 200, body: { ok: true, until: body.until } }),
		});
		return { dq, calls };
	};
	test("Snooze is still one tap for an hour; the ▾ beside it opens the page's other times, closed until tapped", async () => {
		const { dq, calls } = view();
		await settle();
		const more = button(dq, "▾")!;
		expect([more.attrs["aria-label"], more.attrs["aria-expanded"]]).toEqual(["More snooze times", "false"]);
		expect(preset(dq, "Tomorrow morning")).toBeUndefined();
		await tap(dq, "▾");
		expect(more.attrs["aria-expanded"]).toBe("true");
		const list = dq.all((e) => e.className === "dq-snz")[0]!.children;
		expect(list[0]!.textContent).toBe("SNOOZE UNTIL");
		const offered = list.slice(1, -1).map((b) => b.firstChild.textContent);
		expect(offered.filter((t) => t !== "Later today")).toEqual(["Tomorrow morning", "Next week"]);
		// each choice says when it returns; the time of your own is a filled-in input and Set, on one line
		for (const b of list.slice(1, -1)) expect(b.all((e) => e.className === "dq-when")[0]!.textContent).not.toBe("");
		const own = list.at(-1)!;
		expect([own.className, own.children.map((e) => (e.tag === "input" ? e.type : e.textContent))]).toEqual([
			"dq-snz-own",
			["datetime-local", "Set"],
		]);
		expect(Date.parse(own.children[0]!.value)).toBeGreaterThan(Date.now());
		expect(posts(calls)).toEqual([]);
	});
	test("Tomorrow morning is one tap: one snooze POST for 09:00 tomorrow, in this device's time zone", async () => {
		const { dq, calls } = view();
		await settle();
		await tap(dq, "▾");
		await tapPreset(dq, "Tomorrow morning");
		const want = new Date();
		want.setDate(want.getDate() + 1);
		want.setHours(9, 0, 0, 0);
		expect(posts(calls)).toEqual([
			{ method: "POST", path: "/api/items/Q-snz2/snooze", body: { until: want.toISOString() } },
		]);
	});
	test("Next week is the coming Monday at 09:00", async () => {
		const { dq, calls } = view();
		await settle();
		await tap(dq, "▾");
		await tapPreset(dq, "Next week");
		const at = new Date(posts(calls)[0]!.body.until);
		expect([at.getDay(), at.getHours(), at.getMinutes()]).toEqual([1, 9, 0]);
		expect(at.getTime()).toBeGreaterThan(Date.now());
		// On Monday before 09:00 the target is next Monday 09:00: just over seven midnights away.
		expect(at.getTime() - Date.now()).toBeLessThanOrEqual(8 * 86_400_000);
	});
	test("Custom takes a time of your own; a time in the past or none is refused here, with nothing sent", async () => {
		const { dq, calls } = view();
		await settle();
		await tap(dq, "▾");
		const input = dq.all((e) => e.tag === "input")[0]!;
		input.value = "";
		await tap(dq, "Set");
		expect(dq.textContent).toContain("Pick a time in the future.");
		input.value = "2001-01-01T09:00";
		await tap(dq, "Set");
		expect(posts(calls)).toEqual([]);
		const future = new Date(Date.now() + 3 * 86_400_000);
		const pad = (n: number) => String(n).padStart(2, "0");
		input.value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T14:30`;
		await tap(dq, "Set");
		const sent = new Date(posts(calls)[0]!.body.until);
		expect([sent.getDate(), sent.getHours(), sent.getMinutes()]).toEqual([future.getDate(), 14, 30]);
	});
});
