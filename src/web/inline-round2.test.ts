/**
 * Round 2 of the inline view (Nathan, 2026-11-15): a builder's question card answered in place, and the page's other snooze times beside the one-tap
 * Snooze. Run against the in-memory DOM (src/testing/inline-dom.ts); what the server lets the view key do with a card is view-key-cards.test.ts.
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
	test("its options are the row's buttons, beside the thread link; one tap posts the choice and the fingerprint, and the card says it is answered", async () => {
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
		expect(row.children.map((b) => b.textContent)).toEqual(["One table", "People + memberships", "Open the thread"]);
		expect(row.children[1]!.className).toContain("rec");
		await tap(dq, "People + memberships");
		expect(posts(calls)).toEqual([
			{ method: "POST", path: "/api/cards/C-0123456789ab/answer", body: { choice: 1, sig: "sig-1" } },
		]);
		expect(dq.textContent).toContain("Answered: People + memberships. It goes to its thread.");
		// the answered card stays, saying so, with only its thread link; the queue was read again
		expect(dq.all((e) => e.tag === "button" && e.textContent === "One table")).toEqual([]);
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
		await tap(dq, "One table");
		expect(dq.textContent).toContain("the card changed since you saw it");
		expect(button(dq, "One table")?.disabled).toBe(false);
		expect(calls.filter((c) => c.path === "/api/queue").length).toBeGreaterThan(before);
	});
	test("an approval, a goal, a secret and a link card get no answer buttons: only the thread link", async () => {
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
		expect(button(dq, "Tomorrow morning")).toBeUndefined();
		await tap(dq, "▾");
		expect(more.attrs["aria-expanded"]).toBe("true");
		const offered = dq.all((e) => e.className === "dq-snz")[0]!.children.map((b) => b.textContent || b.type);
		expect(offered.filter((t) => t !== "Later today")).toEqual([
			"Tomorrow morning",
			"Next week",
			"datetime-local",
			"Set",
		]);
		expect(posts(calls)).toEqual([]);
	});
	test("Tomorrow morning is one tap: one snooze POST for 09:00 tomorrow, in this device's time zone", async () => {
		const { dq, calls } = view();
		await settle();
		await tap(dq, "▾");
		await tap(dq, "Tomorrow morning");
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
		await tap(dq, "Next week");
		const at = new Date(posts(calls)[0]!.body.until);
		expect([at.getDay(), at.getHours(), at.getMinutes()]).toEqual([1, 9, 0]);
		expect(at.getTime()).toBeGreaterThan(Date.now());
		expect(at.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
	});
	test("Custom takes a time of your own; a time in the past or none is refused here, with nothing sent", async () => {
		const { dq, calls } = view();
		await settle();
		await tap(dq, "▾");
		const input = dq.all((e) => e.tag === "input")[0]!;
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
