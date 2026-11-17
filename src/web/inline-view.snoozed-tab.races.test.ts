/**
 * The Snoozed tab, continued (see inline-view.snoozed-tab.test.ts): a press in flight survives a redraw, a snoozed note in Waiting follows the item
 * when it is dismissed from the tab, and every kind (including a secret or a card pointer) gets Bring back now and Dismiss.
 */
import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { item } from "../testing/web-inline-view-fixtures.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
const UNTIL = "2026-11-15T09:00:00.000Z";
const snoozedItem = (id: string, over: Record<string, unknown> = {}) => ({
	...item("why it was put off"),
	id,
	title: `Snoozed ${id}`,
	thread: "Mobile app",
	open: "/open/main/t1",
	snooze: { until: UNTIL, at: "2026-11-14T12:00:00.000Z", active: true, returned: false },
	...over,
});
const tab = (dq: El, name: string) =>
	dq.all((e) => e.tag === "button" && e.className.split(" ").includes("dq-tab") && e.textContent.startsWith(name))[0]!;
const click = async (b: El) => {
	for (const fn of b.listeners.click ?? []) await fn();
	await settle();
};
const button = (dq: El, text: string) => dq.all((e) => e.tag === "button" && e.textContent === text)[0]!;
const pane = (dq: El, i: number) => dq.querySelector(".dq-tabs")!.parent!.children.at(-1)!.children[i]!;
const rowButtons = (dq: El) =>
	pane(dq, 1)
		.all((e) => e.tag === "button")
		.map((b) => b.textContent);

describe("a press in flight survives a redraw of the Snoozed tab", () => {
	for (const [text, path] of [
		["Bring back now", "/api/items/Q-snz1/unsnooze"],
		["Dismiss", "/api/items/Q-snz1/dismiss"],
	] as const) {
		test(`${text}: a refresh and a tab change (each redraws the row; the periodic read is the same read) between two presses still make one request`, async () => {
			let release = () => {};
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const calls: { method: string; path: string; body?: unknown }[] = [];
			const dq = run(() => ({ items: [], snoozed: [snoozedItem("Q-snz1")] }), {
				src: SRC,
				calls,
				hold: () => gate,
				post: () => ({ status: 200, body: { ok: true } }),
			});
			await settle();
			await click(tab(dq, "Snoozed"));
			const posts = () => calls.filter((c) => c.method === "POST");
			const first = button(dq, text);
			void (first.listeners.click ?? [])[0]!(); // the reply is held: the request is in flight
			await settle();
			expect(posts()).toEqual([{ method: "POST", path, body: {} }]);
			// the queue is read again (Refresh), the tab is left and re-opened: the row is redrawn each time
			await click(button(dq, "Refresh"));
			await click(tab(dq, "Waiting"));
			await click(tab(dq, "Snoozed"));
			const again = button(dq, text);
			expect(again.disabled).toBe(true); // still the row that is waiting for its reply
			for (const fn of again.listeners.click ?? []) await fn();
			await settle();
			expect(posts()).toHaveLength(1);
			release();
			await settle();
			expect(posts()).toHaveLength(1);
		});
	}
});

describe("a snoozed note in Waiting follows its item", () => {
	test("Waiting → Snooze → Snoozed → Dismiss → Waiting: the note that it will return is gone, not left claiming it will", async () => {
		let items: unknown[] = [item("x")];
		let snoozed: unknown[] = [];
		const dq = run(() => ({ items, snoozed }), {
			src: SRC,
			post: (path) => {
				if (path.endsWith("/snooze")) {
					snoozed = [snoozedItem("Q-ctx1")];
					items = [];
				} else snoozed = []; // dismissed from the Snoozed tab: in neither list now
				return { status: 200, body: { ok: true, until: UNTIL } };
			},
		});
		await settle();
		await click(button(dq, "Snooze 1h"));
		expect(pane(dq, 0).textContent).toContain("Snoozed. It returns ");
		await click(tab(dq, "Snoozed"));
		await click(button(dq, "Dismiss"));
		expect(pane(dq, 1).textContent).toBe("Nothing snoozed.");
		await click(tab(dq, "Waiting"));
		expect(pane(dq, 0).textContent).not.toContain("Snoozed. It returns ");
		expect(pane(dq, 0).textContent).toContain("Nothing waiting");
		await click(button(dq, "Refresh"));
		expect(pane(dq, 0).textContent).not.toContain("Snoozed. It returns ");
	});
	test("while the question is still snoozed the note stays", async () => {
		let items: unknown[] = [item("x")];
		let snoozed: unknown[] = [];
		const dq = run(() => ({ items, snoozed }), {
			src: SRC,
			post: () => {
				snoozed = [snoozedItem("Q-ctx1")];
				items = [];
				return { status: 200, body: { ok: true, until: UNTIL } };
			},
		});
		await settle();
		await click(button(dq, "Snooze 1h"));
		await click(button(dq, "Refresh"));
		expect(pane(dq, 0).textContent).toContain("Snoozed. It returns ");
	});
});

describe("what a snoozed row offers depends on what the server will do", () => {
	test("an ordinary question: Bring back now and Dismiss", async () => {
		const dq = run(() => ({ items: [], snoozed: [snoozedItem("Q-snz1")] }), { src: SRC });
		await settle();
		expect(rowButtons(dq)).toEqual(["Bring back now", "Dismiss"]);
	});
	for (const [name, extra] of [
		["a secret", { secret: true }],
		["a card pointer", { cardRequest: { requestId: "r" } }],
	] as const) {
		test(`${name}: Bring back now, Dismiss and the thread link`, async () => {
			const dq = run(() => ({ items: [], snoozed: [snoozedItem("Q-snz1", extra)] }), { src: SRC });
			await settle();
			expect(rowButtons(dq)).toEqual(["Bring back now", "Dismiss"]);
			expect(
				pane(dq, 1)
					.all((e) => e.tag === "a")
					.map((a) => a.textContent),
			).toEqual(["Open the thread"]);
		});
	}
});
