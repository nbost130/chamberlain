/**
 * The Snoozed tab of the Decisions view (src/web/static/inline.js): the tab beside Waiting, what each row says, and the two one-press actions on a
 * row, Bring back now and Dismiss, which are the view key's own writes (src/web/view-key.ts). Run against the in-memory DOM (src/testing/inline-dom.ts).
 */
import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { item } from "../testing/web-inline-view-fixtures.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
const snoozedItem = (id: string, until: string, over: Record<string, unknown> = {}) => ({
	...item("why it was put off"),
	id,
	title: `Snoozed ${id}`,
	thread: "Mobile app",
	open: "/open/main/t1",
	snooze: { until, at: "2026-11-14T12:00:00.000Z", active: true, returned: false },
	...over,
});
const tabs = (dq: El) => dq.all((e) => e.tag === "button" && e.className.split(" ").includes("dq-tab"));
const tab = (dq: El, name: string) => tabs(dq).find((b) => b.textContent.startsWith(name))!;
const count = (b: El) => b.querySelector(".dq-tab-n")!.textContent;
const open = async (dq: El, name: string) => {
	for (const fn of tab(dq, name).listeners.click ?? []) await fn();
	await settle();
};
const pane = (dq: El, i: number) => dq.querySelector(".dq-tabs")!.parent!.children.at(-1)!.children[i]!;
const press = async (dq: El, text: string) => {
	const b = dq.all((e) => e.tag === "button" && e.textContent === text)[0]!;
	for (const fn of b.listeners.click ?? []) await fn();
	await settle();
};
type Call = { method: string; path: string; body?: unknown };

describe("the tab row", () => {
	test("Waiting, Snoozed, Rulings, Recent: Snoozed directly after Waiting, each of those two with its count", async () => {
		const dq = run(() => ({ items: [item("x")], snoozed: [snoozedItem("Q-snz1", "2026-11-15T09:00:00.000Z")] }), {
			src: SRC,
		});
		await settle();
		expect(tabs(dq).map((b) => b.textContent.replace(/\d+|…/, "").trim())).toEqual([
			"Waiting",
			"Snoozed",
			"Rulings",
			"Recent",
		]);
		expect([count(tab(dq, "Waiting")), count(tab(dq, "Snoozed"))]).toEqual(["1", "1"]);
		expect(tab(dq, "Snoozed").attrs["aria-label"]).toBe("Snoozed, 1");
		expect(tab(dq, "Waiting").className).toContain("on");
		expect(dq.querySelector(".dq-count")!.textContent).toBe("1 waiting"); // what is snoozed is not what is waiting
	});
	test("the old collapsible Snoozed block is gone: nothing snoozed shows outside the tab", async () => {
		const dq = run(() => ({ items: [], snoozed: [snoozedItem("Q-snz1", "2026-11-15T09:00:00.000Z")] }), { src: SRC });
		await settle();
		expect(dq.querySelector(".dq-snoozed")).toBeNull();
		expect(dq.all((e) => e.tag === "details" && e.className !== "dq-health")).toEqual([]);
		expect(dq.textContent).not.toContain("SNOOZED ·");
		expect(pane(dq, 0).textContent).not.toContain("Snoozed Q-snz1"); // not in the Waiting pane
		expect(pane(dq, 1).style.display).toBe("none"); // and not on screen until the tab is opened
		await open(dq, "Snoozed");
		expect(pane(dq, 1).style.display).toBe("");
		expect(pane(dq, 0).style.display).toBe("none");
		expect(tab(dq, "Snoozed").className).toContain("on");
		expect(pane(dq, 1).textContent).toContain("Snoozed Q-snz1");
	});
	test("with nothing snoozed the tab says so and counts 0", async () => {
		const dq = run(() => ({ items: [], snoozed: [] }), { src: SRC });
		await settle();
		await open(dq, "Snoozed");
		expect(pane(dq, 1).textContent).toBe("Nothing snoozed.");
		expect(count(tab(dq, "Snoozed"))).toBe("0");
	});
});

describe("each row", () => {
	test("says what it is, whose thread, and when it returns; the soonest return is first", async () => {
		const dq = run(
			() => ({
				items: [],
				snoozed: [snoozedItem("Q-late", "2026-11-20T09:00:00.000Z"), snoozedItem("Q-soon", "2026-11-15T09:00:00.000Z")],
			}),
			{ src: SRC },
		);
		await settle();
		await open(dq, "Snoozed");
		const rows = pane(dq, 1).children;
		expect(rows.map((r) => r.querySelector(".dq-title")!.textContent)).toEqual(["Snoozed Q-soon", "Snoozed Q-late"]);
		expect(rows[0]!.textContent).toContain("Mobile app · returns ");
		expect(rows[0]!.textContent).toContain("why it was put off");
		expect(count(tab(dq, "Snoozed"))).toBe("2");
	});
	test("offers Bring back now, Dismiss and the thread link, and no answer buttons", async () => {
		const dq = run(() => ({ items: [], snoozed: [snoozedItem("Q-snz1", "2026-11-15T09:00:00.000Z")] }), { src: SRC });
		await settle();
		const row = pane(dq, 1).children[0]!;
		expect(row.all((e) => e.tag === "button").map((b) => b.textContent)).toEqual(["Bring back now", "Dismiss"]);
		expect(row.all((e) => e.tag === "a").map((a) => [a.textContent, a.href])).toEqual([
			["Open the thread", "http://queue.test/open/main/t1"],
		]);
		expect(row.all((e) => e.tag === "textarea")).toEqual([]);
		expect(row.all((e) => e.className.split(" ").includes("rec")).map((b) => b.textContent)).toEqual([
			"Bring back now",
		]);
	});
});

/** A queue whose one snoozed item moves when a POST lands, as the server does. */
function live(over: { fail?: { status: number; body: unknown } } = {}) {
	let snoozed = [snoozedItem("Q-snz1", "2026-11-15T09:00:00.000Z")];
	let items: unknown[] = [];
	const calls: Call[] = [];
	const headers: Record<string, string>[] = [];
	const dq = run(() => ({ items, snoozed }), {
		src: SRC,
		calls,
		headers,
		post: (path) => {
			if (over.fail) return over.fail;
			if (path.endsWith("/unsnooze"))
				items = [item("back")].map((i) => ({ ...i, id: "Q-snz1", title: "Snoozed Q-snz1" }));
			snoozed = [];
			return { status: 200, body: { ok: true, id: "Q-snz1" } };
		},
	});
	return { dq, calls, headers, posts: () => calls.filter((c) => c.method === "POST") };
}

describe("one press is one request", () => {
	test("Bring back now: one POST to unsnooze with the view key, then the queue is read again and the item is on the waiting list", async () => {
		const { dq, posts, headers, calls } = live();
		await settle();
		await open(dq, "Snoozed");
		const reads = calls.filter((c) => c.path === "/api/queue").length;
		await press(dq, "Bring back now");
		expect(posts()).toEqual([{ method: "POST", path: "/api/items/Q-snz1/unsnooze", body: {} }]);
		expect(headers.find((h) => h["x-decision-queue"])).toMatchObject({ "x-decision-token": "VIEWKEY" });
		expect(calls.filter((c) => c.path === "/api/queue").length).toBeGreaterThan(reads);
		expect(pane(dq, 1).textContent).toBe("Nothing snoozed.");
		expect(count(tab(dq, "Snoozed"))).toBe("0");
		expect(count(tab(dq, "Waiting"))).toBe("1");
		expect(pane(dq, 0).textContent).toContain("Snoozed Q-snz1");
		expect(dq.querySelector(".dq-count")!.textContent).toBe("1 waiting");
	});
	test("Dismiss: one POST to dismiss with an empty body, and the row leaves", async () => {
		const { dq, posts } = live();
		await settle();
		await open(dq, "Snoozed");
		await press(dq, "Dismiss");
		expect(posts()).toEqual([{ method: "POST", path: "/api/items/Q-snz1/dismiss", body: {} }]);
		expect(pane(dq, 1).textContent).toBe("Nothing snoozed.");
		expect(count(tab(dq, "Waiting"))).toBe("0");
	});
	test("a refusal shows on the row, nothing leaves, and the buttons come back", async () => {
		const { dq, posts } = live({ fail: { status: 409, body: { error: "that item is not snoozed" } } });
		await settle();
		await open(dq, "Snoozed");
		await press(dq, "Bring back now");
		const row = pane(dq, 1).children[0]!;
		expect(row.textContent).toContain("that item is not snoozed");
		expect(row.all((e) => e.tag === "button").map((b) => b.disabled)).toEqual([false, false]);
		await press(dq, "Bring back now");
		expect(posts()).toHaveLength(2); // it can be tried again
	});
	test("a second press while the first is in flight sends nothing more", async () => {
		const { dq, posts } = live();
		await settle();
		const fns = dq.all((e) => e.tag === "button" && e.textContent === "Bring back now")[0]!.listeners.click ?? [];
		await Promise.all([fns[0]!(), fns[0]!()]);
		await settle();
		expect(posts()).toHaveLength(1);
	});
});

describe("a card snoozed in the Waiting tab", () => {
	test("is shown as snoozed, and when the question is back on the list the live card replaces that note", async () => {
		let items: unknown[] = [item("x")];
		let snoozed: unknown[] = [];
		const dq = run(() => ({ items, snoozed }), {
			src: SRC,
			post: () => {
				items = [];
				snoozed = [snoozedItem("Q-ctx1", "2026-11-15T09:00:00.000Z")];
				return { status: 200, body: { ok: true, until: "2026-11-15T09:00:00.000Z" } };
			},
		});
		await settle();
		await press(dq, "Snooze");
		expect(pane(dq, 0).textContent).toContain("Snoozed. It returns ");
		expect(count(tab(dq, "Snoozed"))).toBe("1");
		items = [item("x")]; // its time passed, or it was brought back
		snoozed = [];
		await press(dq, "Refresh");
		expect(pane(dq, 0).textContent).not.toContain("Snoozed. It returns ");
		expect(pane(dq, 0).all((e) => e.tag === "button" && e.textContent === "Snooze")).toHaveLength(1);
		expect(count(tab(dq, "Snoozed"))).toBe("0");
	});
});
