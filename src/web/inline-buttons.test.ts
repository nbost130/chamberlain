/**
 * A decision card, pick then answer (Nathan, 2026-11-17, mockup A "Pick, then confirm"): a question's options are one choice list (dq-opts), each
 * option a row with its label and its detail in full, the recommended one tagged and chosen to start with; one filled answer button under the list
 * (dq-confirm) names the chosen option, and its tap is the one request. Under that, one quiet row (dq-actions) of the actions every card has (dq-sec:
 * Snooze 1h with its ▾ joined to it, Dismiss, Direction, the thread link, Bring back now). This replaces the one row of option and action pills of
 * 2026-11-15 round 2, whose options were cut short and said twice. Run against the in-memory DOM (src/testing/inline-dom.ts); what each action button
 * does is src/web/inline-act.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type El, run, settle } from "../testing/inline-dom.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
const JS = readFileSync(new URL("./static/inline.js", import.meta.url), "utf8");
const item = (over: Record<string, unknown> = {}) => ({
	id: "Q-btn1",
	kind: "product",
	title: "Which one?",
	options: [
		{ label: "Yes: allow /open for the view key", detail: "one route, read-only" },
		{ label: "No: keep /open full-key only" },
	],
	recommended: 0,
	status: "open",
	createdAt: new Date().toISOString(),
	open: "/open/main/t1",
	...over,
});
const has = (e: El, cls: string) => e.className.split(" ").includes(cls);
const buttons = (dq: El) => dq.all((e) => e.tag === "button" && has(e, "dq-btn"));
const text = (xs: El[]) => xs.map((x) => x.textContent);
const rows = (dq: El) => dq.all((e) => has(e, "dq-opt"));
const label = (r: El) => r.all((e) => has(e, "dq-l"))[0]!.textContent;
const answerBtn = (dq: El) => dq.all((e) => has(e, "dq-confirm"))[0];
const click = async (e: El) => {
	for (const fn of e.listeners.click ?? []) await fn();
	await settle();
};
const view = (
	over: Record<string, unknown> = {},
	post?: (path: string, body: any) => { status: number; body: unknown },
) => {
	const calls: { method: string; path: string; body?: any }[] = [];
	const dq = run(() => ({ items: [item(over)] }), { src: SRC, calls, ...(post ? { post } : {}) });
	return { dq, posts: () => calls.filter((c) => c.method === "POST") };
};

describe("a question's options are one choice list, answered by one button under it", () => {
	test("each option is a radio row with its full label and its detail; the recommended one is tagged and starts chosen", async () => {
		const { dq } = view();
		await settle();
		const group = dq.all((e) => has(e, "dq-opts"))[0]!;
		expect([group.attrs.role, group.attrs["aria-label"]]).toEqual(["radiogroup", "Options"]);
		const [yes, no] = rows(dq);
		expect(rows(dq).map((r) => [r.tag, r.attrs.role])).toEqual([
			["button", "radio"],
			["button", "radio"],
		]);
		expect(rows(dq).map(label)).toEqual(["Yes: allow /open for the view key", "No: keep /open full-key only"]);
		expect(yes!.textContent).toBe("RecommendedYes: allow /open for the view keyone route, read-only");
		expect(no!.all((e) => has(e, "dq-tag"))).toEqual([]);
		expect([has(yes!, "sel"), yes!.attrs["aria-checked"], has(no!, "sel"), no!.attrs["aria-checked"]]).toEqual([
			true,
			"true",
			false,
			"false",
		]);
		// each option is said once: no separate detail line under the list, and no option pill in the action row
		expect(dq.all((e) => e.className === "dq-d").map((e) => e.parent?.className)).toEqual(["dq-opt-t"]);
	});
	test("the answer button names the chosen option; picking another row moves the choice and sends nothing", async () => {
		const { dq, posts } = view();
		await settle();
		expect(answerBtn(dq)!.textContent).toBe("Yes: allow /open for the view key");
		expect(answerBtn(dq)!.attrs["aria-label"]).toBe("Answer: Yes: allow /open for the view key");
		await click(rows(dq)[1]!);
		expect(answerBtn(dq)!.textContent).toBe("No: keep /open full-key only");
		expect(rows(dq).map((r) => has(r, "sel"))).toEqual([false, true]);
		expect(posts()).toEqual([]);
	});
	test("the answer button is the one request: the chosen option, nothing else", async () => {
		const { dq, posts } = view({}, () => ({ status: 200, body: { ok: true, choice: "No", to: "steward" } }));
		await settle();
		await click(rows(dq)[1]!);
		await click(answerBtn(dq)!);
		expect(posts()).toEqual([{ method: "POST", path: "/api/items/Q-btn1/answer", body: { choice: 1 } }]);
	});
	test("with no recommendation nothing starts chosen, and the button asks for a pick instead of sending", async () => {
		const { dq, posts } = view({ recommended: undefined });
		await settle();
		expect(rows(dq).map((r) => has(r, "sel"))).toEqual([false, false]);
		expect(dq.all((e) => has(e, "dq-tag"))).toEqual([]);
		expect(answerBtn(dq)!.textContent).toBe("Pick an option");
		expect(answerBtn(dq)!.className).toContain("dq-none");
		await click(answerBtn(dq)!);
		expect(posts()).toEqual([]);
		expect(dq.textContent).toContain("Pick an option first.");
	});
	test("under the answer button, one quiet row: Snooze 1h, ▾, Dismiss, Direction, the thread link, all dq-sec", async () => {
		const { dq } = view();
		await settle();
		const all = dq.all((e) => has(e, "dq-actions"));
		expect(all).toHaveLength(1);
		const row = all[0]!.children;
		expect(text(row)).toEqual(["Snooze 1h", "▾", "Dismiss", "Direction", "Open the thread"]);
		expect(row.every((b) => has(b, "dq-sec") && !has(b, "rec"))).toBe(true);
		expect(row[0]!.attrs["aria-label"]).toBe("Snooze for 1 hour");
		expect(has(row[0]!, "dq-snooze") && has(row[1]!, "dq-more")).toBe(true);
		// the list and its button come before the row, in that order
		const card = all[0]!.parent!.children;
		const at = (cls: string) => card.findIndex((e) => has(e, cls));
		expect(at("dq-opts")).toBeLessThan(at("dq-confirm"));
		expect(at("dq-confirm")).toBeLessThan(at("dq-actions"));
	});
	test("a secret and a card pointer have no options and no answer button, and every button they do have is dq-sec", async () => {
		for (const extra of [{ secret: true, options: [] }, { cardRequest: "r1" }]) {
			const { dq } = view(extra);
			await settle();
			expect(rows(dq)).toEqual([]);
			expect(answerBtn(dq)).toBeUndefined();
			expect(buttons(dq).every((b) => has(b, "dq-sec"))).toBe(true);
		}
	});
	test("a snoozed card's Bring back now, Dismiss and thread link are all dq-sec", async () => {
		const snoozed = {
			...item({ id: "Q-snz1", thread: "Mobile app", threadId: "t1" }),
			snooze: { until: "2026-11-15T09:00:00.000Z", active: true },
		};
		const dq = run(() => ({ items: [], snoozed: [snoozed] }), { src: SRC });
		await settle();
		const row = dq.all((e) => has(e, "dq-actions"))[0]!;
		expect(text(row.children)).toEqual(["Bring back now", "Dismiss", "Open the thread"]);
		expect(row.children.every((b) => has(b, "dq-sec"))).toBe(true);
	});
	test("answering takes the list and its button away, and what is left is the quiet thread link", async () => {
		const { dq } = view({}, () => ({ status: 200, body: { ok: true, choice: "Yes", to: "steward" } }));
		await settle();
		await click(answerBtn(dq)!);
		expect([rows(dq), dq.all((e) => has(e, "dq-opts"))]).toEqual([[], []]);
		expect(answerBtn(dq)).toBeUndefined();
		expect(text(dq.all((e) => has(e, "dq-actions"))[0]!.children)).toEqual(["Open the thread"]);
	});
});

describe("the stylesheet", () => {
	const rule = (sel: string) =>
		// a selector's own rule: it starts a rule, so a selector list that merely ends with it is not a match
		JS.match(new RegExp(`(?:^|[}\\n])${sel.replace(/[.()>:]/g, "\\$&")}\\{([^}]*)\\}`))![1]!;
	const px = (r: string, prop: string) => Number(new RegExp(`(?:^|;)${prop}:(\\d+)px`).exec(r)![1]);
	const every = ".dq-actions>.dq-btn,.dq-actions>.dq-pill,.dq-snz>.dq-btn";
	test("every button in the action row has one fixed height and is one line", () => {
		const r = rule(every);
		expect(px(r, "height")).toBe(34);
		expect(r).toContain("white-space:nowrap");
		expect(r).toContain("text-overflow:ellipsis");
		expect(r).toContain("max-width:100%");
	});
	test("the always-there actions are quiet (no outline, no fill), and only Snooze and its ▾ keep an outline, joined into one control", () => {
		expect(rule(".dq-actions>.dq-sec:not(.rec):not(.dq-snooze):not(.dq-more)")).toContain(
			"border-color:transparent;background:none",
		);
		expect(rule(".dq-actions>.dq-snooze,.dq-actions>.dq-more")).toContain("border-color:var(--border)");
		expect(rule(".dq-actions>.dq-snooze")).toContain("border-radius:999px 0 0 999px");
		const more = rule(".dq-actions>.dq-more");
		expect(more).toContain("border-radius:0 999px 999px 0");
		expect(more).toMatch(/margin-left:-\d+px/);
	});
	test("an option row wraps its label instead of cutting it short; the chosen row and the answer button are the primary colour", () => {
		expect(rule(".dq-opt .dq-l")).toContain("overflow-wrap:anywhere");
		expect(rule(".dq-opt")).not.toContain("nowrap");
		expect(rule(".dq-opt.sel")).toContain("border-color:var(--primary)");
		expect(rule(".dq-confirm")).toContain("width:100%");
		expect(JS).toMatch(/\.dq-btn\.rec,\.dq-pill\.rec,\.dq-go\{background:var\(--primary\)/);
	});
	test("a touch screen makes every small button 40px", () => {
		expect(JS).toContain(
			"@media(pointer:coarse){.dq-actions>.dq-btn,.dq-actions>.dq-pill,.dq-snz>.dq-btn,.dq-snz-own>.dq-btn,.dq-snz-own input{height:40px;line-height:38px}}",
		);
	});
	test("the action row wraps and the tab row stays one row", () => {
		expect(rule(".dq-actions")).toContain("flex-wrap:wrap");
		expect(rule(".dq-tabs")).toContain("flex-wrap:nowrap");
	});
});
