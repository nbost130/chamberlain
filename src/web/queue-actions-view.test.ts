/**
 * The queue page (static/app.js) against stubbed browser globals: the little buttons along an item's bottom edge (Open thread, Snooze,
 * Direction, Dismiss), the snooze choices, the collapsed Snoozed section, and what each tap sends. Dates are local, as the page's are.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
/** Saturday 14 November 2026, 12:00 in whatever zone the test runs in. */
const NOW = new Date(2026, 10, 14, 12, 0, 0);

const item = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	kind: "product",
	title: `Title ${id}`,
	context: "ctx",
	options: [{ label: "A · One" }, { label: "B · Two" }],
	recommended: 0,
	status: "open",
	createdAt: "2026-11-14T08:00:00.000Z",
	thread: "Billing thread",
	server: "main",
	open: "/open/main/t1",
	batchable: true,
	...over,
});
const snoozedItem = (id: string, until: Date, over: Record<string, unknown> = {}) =>
	item(id, { snooze: { until: until.toISOString(), at: NOW.toISOString(), active: true, returned: false }, ...over });

type Call = { path: string; body: any };
/** The page with a queue in it: its taps, typing and timers can be driven, and every request it makes is recorded. */
async function page(
	queue: () => { items: unknown[]; snoozed?: unknown[]; cards?: unknown[] },
	o: {
		now?: Date;
		path?: string;
		reply?: (path: string, body: any) => { status?: number; json: unknown };
		confirm?: () => boolean;
	} = {},
) {
	const now = o.now ?? NOW;
	const listeners: Record<string, (ev: any) => unknown> = {};
	const app: any = {
		innerHTML: "",
		className: "",
		addEventListener: (t: string, f: (ev: any) => unknown) => {
			listeners[t] = f;
		},
	};
	const toast = { textContent: "", className: "", hidden: true };
	const custom = { value: "" };
	const note = { focused: false, focus() {} };
	note.focus = () => {
		note.focused = true;
	};
	const calls: Call[] = [];
	/** The addresses the page replaced its own with (a phone moves on to the next item this way). */
	const went: string[] = [];
	let reads = 0;
	const timers: { fn: () => unknown; ms: number }[] = [];
	const document = {
		getElementById: (id: string) =>
			id === "app" ? app : id === "toast" ? toast : id === "snooze-custom" ? custom : id === "note" ? note : null,
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const fetch = async (path: string, init?: { body?: string }) => {
		if (!init?.body) {
			reads++;
			return { ok: true, status: 200, json: async () => ({ cards: [], rulings: [], ...queue() }) };
		}
		const body = JSON.parse(init.body);
		calls.push({ path, body });
		const r = o.reply?.(path, body) ?? { json: { ok: true, until: "2026-11-14T13:00:00.000Z" } };
		return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json };
	};
	class FixedDate extends Date {
		constructor(...a: unknown[]) {
			super(...((a.length ? a : [now.getTime()]) as [number]));
		}
		static override now() {
			return now.getTime();
		}
	}
	const noop = () => {};
	new Function(
		"document",
		"window",
		"location",
		"history",
		"matchMedia",
		"fetch",
		"setTimeout",
		"clearTimeout",
		"setInterval",
		"confirm",
		"Date",
		SOURCE,
	)(
		document,
		{ addEventListener: noop },
		{ pathname: o.path ?? "/" },
		{ replaceState: (_s: unknown, _t: string, path: string) => went.push(path), pushState: noop },
		() => ({ matches: false }),
		fetch,
		(fn: () => unknown, ms: number) => timers.push({ fn, ms }),
		noop,
		() => 0,
		o.confirm ?? (() => true),
		FixedDate,
	);
	const settle = () => new Promise((r) => setTimeout(r, 15));
	await settle();
	/** A tap on an element that carries these data attributes (the page delegates every click from #app). */
	const tap = async (dataset: Record<string, string>) => {
		await listeners.click({ target: { closest: () => ({ dataset }) } });
		await settle();
	};
	const type = async (id: string, value: string) => {
		await listeners.input({ target: { id, value } });
	};
	return {
		app,
		toast,
		custom,
		note,
		calls,
		went,
		tap,
		type,
		settle,
		timers,
		reads: () => reads,
		html: () => app.innerHTML as string,
	};
}

const BUTTONS = ["Open thread", "Snooze", "Direction", "Dismiss"];
/** The row of little buttons along the bottom of the item's detail: its text, in order. */
const rowOf = (html: string) => {
	const row = html.match(/<div class="item-actions"[^>]*>(.*?)<\/div>/s)?.[1] ?? "";
	return [...row.matchAll(/<(?:a|button)[^>]*>([^<]*)<\/(?:a|button)>/g)].map((m) => m[1]);
};
const at = (d: Date) => d.toISOString();

describe("the buttons along an item's bottom edge", () => {
	test("are Open thread, Snooze, Direction, Dismiss, in that order, as small quiet buttons after the answer controls", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		expect(rowOf(p.html())).toEqual(BUTTONS);
		const html = p.html();
		const row = html.indexOf('class="item-actions"');
		expect(row).toBeGreaterThan(html.indexOf('class="btn-answer"'));
		expect(row).toBeGreaterThan(html.indexOf('data-act="not-now"'));
		// every one is the page's small `mini` button: none is a primary or a ghost button
		const inRow = html.slice(row, html.indexOf("</div>", row));
		expect(inRow.match(/class="mini"/g)).toHaveLength(4);
		expect(inRow).not.toMatch(/btn-(answer|primary|ghost)/);
		expect(inRow).toContain('<a class="mini" href="/open/main/t1">Open thread</a>');
	});
	test("take the thread link out of the crumbs at the top: it lives only in the row", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		expect(p.html().match(/>Open thread</g)).toHaveLength(1);
		expect(p.html()).not.toContain('<a class="open"');
	});
	test("with no thread link, the crumbs still say where the thread is, and the row has the other three", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa", { open: undefined, threadId: "t-9" })] }));
		expect(rowOf(p.html())).toEqual(["Snooze", "Direction", "Dismiss"]);
		expect(p.html()).toContain('<span class="open">main · t-9</span>');
	});
	test("a secret and a card pointer, which are settled in their own thread, get only the thread link and Snooze", async () => {
		for (const extra of [{ secret: true, options: [] }, { cardRequest: "req-1" }]) {
			const p = await page(() => ({ items: [item("Q-aaaa", extra)] }));
			expect(rowOf(p.html())).toEqual(["Open thread", "Snooze"]);
			expect(p.html()).not.toContain('data-act="direction"');
			expect(p.html()).not.toContain('data-act="dismiss"');
			await p.tap({ act: "direction" });
			await p.tap({ act: "dismiss" });
			expect(p.calls).toEqual([]);
		}
	});
	test("a quiet stylesheet: small text, no fill, and a bigger touch target only on a phone", () => {
		const css = readFileSync(new URL("./static/app.css", import.meta.url), "utf8");
		const rule = css.match(/\.mini \{([^}]*)\}/)![1]!;
		expect(rule).toContain("font-size: 12px");
		expect(rule).toContain("background: transparent");
		expect(rule).toContain("border: 1px solid transparent");
		expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.mini \{[^}]*min-height: 36px/);
	});
});

describe("snooze", () => {
	test("offers 1 hour, later today, tomorrow morning, next week and a custom time, and nothing until Snooze is tapped", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		expect(p.html()).not.toContain('class="snooze-panel"');
		expect(p.html()).toContain('data-act="snooze-panel" aria-expanded="false"');
		await p.tap({ act: "snooze-panel" });
		expect(p.html()).toContain('data-act="snooze-panel" aria-expanded="true"');
		const labels = [...p.html().matchAll(/data-snooze="(\w+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
		expect(labels).toEqual([
			["hour", "1 hour"],
			["later", "Later today"],
			["tomorrow", "Tomorrow morning"],
			["week", "Next week"],
		]);
		expect(p.html()).toContain('type="datetime-local"');
		await p.tap({ act: "snooze-panel" });
		expect(p.html()).not.toContain('class="snooze-panel"');
	});
	test("each choice sends the absolute time it means, in the browser's own zone", async () => {
		const expected: Record<string, Date> = {
			hour: new Date(2026, 10, 14, 13, 0),
			later: new Date(2026, 10, 14, 18, 0),
			tomorrow: new Date(2026, 10, 15, 9, 0),
			week: new Date(2026, 10, 16, 9, 0), // the coming Monday
		};
		for (const [id, when] of Object.entries(expected)) {
			const p = await page(() => ({ items: [item("Q-aaaa")] }));
			await p.tap({ act: "snooze-panel" });
			await p.tap({ snooze: id });
			expect(p.calls).toEqual([{ path: "/api/items/Q-aaaa/snooze", body: { until: at(when) } }]);
		}
	});
	test("later today is three hours on when evening is under an hour away, and left out when that would be tomorrow", async () => {
		const evening = await page(() => ({ items: [item("Q-aaaa")] }), { now: new Date(2026, 10, 14, 17, 30) });
		await evening.tap({ act: "snooze-panel" });
		await evening.tap({ snooze: "later" });
		expect(evening.calls[0]!.body.until).toBe(at(new Date(2026, 10, 14, 20, 30)));
		const night = await page(() => ({ items: [item("Q-aaaa")] }), { now: new Date(2026, 10, 14, 22, 0) });
		await night.tap({ act: "snooze-panel" });
		expect(night.html()).not.toContain('data-snooze="later"');
	});
	test("next week is the coming Monday, whichever day it is, never today", async () => {
		const days: [Date, Date][] = [
			[new Date(2026, 10, 16, 12, 0), new Date(2026, 10, 23, 9, 0)], // Monday: a week on
			[new Date(2026, 10, 15, 12, 0), new Date(2026, 10, 16, 9, 0)], // Sunday: tomorrow
			[new Date(2026, 10, 18, 12, 0), new Date(2026, 10, 23, 9, 0)], // Wednesday
		];
		for (const [now, monday] of days) {
			const p = await page(() => ({ items: [item("Q-aaaa")] }), { now });
			await p.tap({ act: "snooze-panel" });
			await p.tap({ snooze: "week" });
			expect(p.calls[0]!.body.until).toBe(at(monday));
		}
	});
	test("a custom time is read from the box in the browser's zone; an empty or broken one sends nothing", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		await p.tap({ act: "snooze-panel" });
		await p.tap({ act: "snooze-custom" });
		p.custom.value = "not a time";
		await p.tap({ act: "snooze-custom" });
		expect(p.calls).toEqual([]);
		expect(p.toast.textContent).toBe("Pick a date and time first.");
		p.custom.value = "2026-11-20T08:30";
		await p.tap({ act: "snooze-custom" });
		expect(p.calls).toEqual([{ path: "/api/items/Q-aaaa/snooze", body: { until: at(new Date(2026, 10, 20, 8, 30)) } }]);
	});
	test("says when it returns, and a refusal from the server is shown, not swallowed", async () => {
		const ok = await page(() => ({ items: [item("Q-aaaa")] }), {
			reply: () => ({ json: { ok: true, until: at(new Date(2026, 10, 14, 13, 0)) } }),
		});
		await ok.tap({ act: "snooze-panel" });
		await ok.tap({ snooze: "hour" });
		expect(ok.toast.textContent).toContain("Snoozed “Title Q-aaaa” until ");
		expect(ok.toast.textContent).toContain("It comes back by itself.");
		const refused = await page(() => ({ items: [item("Q-aaaa")] }), {
			reply: () => ({ status: 400, json: { error: "until must be in the future" } }),
		});
		await refused.tap({ act: "snooze-panel" });
		await refused.tap({ snooze: "hour" });
		expect([refused.toast.textContent, refused.toast.className]).toEqual(["until must be in the future", "toast err"]);
	});
});

describe("the Snoozed section", () => {
	test("is collapsed by default: it says how many, and shows none of them until it is opened", async () => {
		const p = await page(() => ({
			items: [item("Q-aaaa")],
			snoozed: [
				snoozedItem("Q-bbbb", new Date(2026, 10, 15, 9, 0)),
				snoozedItem("Q-cccc", new Date(2026, 10, 16, 9, 0)),
			],
		}));
		const html = p.html();
		expect(html).toContain('data-act="toggle-snoozed" aria-expanded="false"');
		expect(html).toContain("SNOOZED · 2");
		expect(html).not.toContain("Title Q-bbbb");
		expect(html).not.toContain("Title Q-cccc");
		expect(html).not.toContain('class="srow"');
		// the active list is just the one waiting item, and the header counts only it
		expect(html).toContain("1 waiting");
		expect(html).toContain("Title Q-aaaa");
	});
	test("opens to show each item, when it returns, and Un-snooze; closes again", async () => {
		const p = await page(() => ({ items: [], snoozed: [snoozedItem("Q-bbbb", new Date(2026, 10, 15, 9, 0))] }));
		expect(p.html()).toContain("Nothing waiting on you.");
		expect(p.html()).toContain("SNOOZED · 1");
		await p.tap({ act: "toggle-snoozed" });
		expect(p.html()).toContain('aria-expanded="true"');
		expect(p.html()).toContain("Title Q-bbbb");
		expect(p.html()).toContain("returns ");
		expect(p.html()).toContain('data-act="unsnooze" data-id="Q-bbbb">Un-snooze<');
		await p.tap({ act: "toggle-snoozed" });
		expect(p.html()).not.toContain("Title Q-bbbb");
	});
	test("is absent when nothing is snoozed", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		expect(p.html()).not.toContain("SNOOZED");
		expect(p.html()).not.toContain("snoozed-head");
	});
	test("Un-snooze sends the item's id and reloads the queue", async () => {
		let snoozed = [snoozedItem("Q-bbbb", new Date(2026, 10, 15, 9, 0))];
		const p = await page(() => ({ items: [], snoozed }));
		await p.tap({ act: "toggle-snoozed" });
		const before = p.reads();
		snoozed = [];
		await p.tap({ act: "unsnooze", id: "Q-bbbb" });
		expect(p.calls).toEqual([{ path: "/api/items/Q-bbbb/unsnooze", body: {} }]);
		expect(p.reads()).toBeGreaterThan(before);
		expect(p.toast.textContent).toBe("Back on the active list.");
		expect(p.html()).not.toContain("SNOOZED");
	});
	test("reloads by itself when the soonest snoozed item is due, so it returns without a tap", async () => {
		const p = await page(() => ({
			items: [],
			snoozed: [
				snoozedItem("Q-bbbb", new Date(2026, 10, 14, 13, 30)),
				snoozedItem("Q-cccc", new Date(2026, 10, 15, 9, 0)),
			],
		}));
		const timer = p.timers.at(-1)!;
		// 90 minutes to the soonest, plus a second for the server's clock
		expect(timer.ms).toBe(90 * 60_000 + 1000);
		const before = p.reads();
		await timer.fn();
		await p.settle();
		expect(p.reads()).toBe(before + 1);
		const none = await page(() => ({ items: [item("Q-aaaa")] }));
		expect(none.timers).toEqual([]);
	});
});

describe("direction", () => {
	test("needs the note: with none, it sends nothing, says so and moves to the note box", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }));
		await p.tap({ act: "direction" });
		expect(p.calls).toEqual([]);
		expect(p.toast.textContent).toContain("Write your direction in the note first");
		expect(p.toast.className).toBe("toast err");
		expect(p.note.focused).toBe(true);
		await p.type("note", "   ");
		await p.tap({ act: "direction" });
		expect(p.calls).toEqual([]);
	});
	test("sends the note and no option: the request has no choice at all", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }), {
			reply: () => ({ json: { ok: true, kind: "direction" } }),
		});
		await p.type("note", "  Do A, skip the migration  ");
		await p.tap({ act: "direction" });
		expect(p.calls).toEqual([{ path: "/api/items/Q-aaaa/direction", body: { note: "Do A, skip the migration" } }]);
		expect(Object.keys(p.calls[0]!.body)).toEqual(["note"]);
		expect(p.toast.textContent).toContain("no option was chosen");
	});
	test("a refusal from the server is shown", async () => {
		const p = await page(() => ({ items: [item("Q-aaaa")] }), {
			reply: () => ({ status: 409, json: { error: "already answered" } }),
		});
		await p.type("note", "go");
		await p.tap({ act: "direction" });
		expect(p.toast.textContent).toBe("already answered");
	});
});

describe("dismiss", () => {
	test("asks first, and sends nothing when it is declined", async () => {
		const asked: string[] = [];
		const p = await page(() => ({ items: [item("Q-aaaa")] }), {
			confirm: () => {
				asked.push("asked");
				return false;
			},
		});
		await p.tap({ act: "dismiss" });
		expect(asked).toEqual(["asked"]);
		expect(p.calls).toEqual([]);
	});
	test("needs no note; with one, sends it; says nothing was answered", async () => {
		const bare = await page(() => ({ items: [item("Q-aaaa")] }));
		await bare.tap({ act: "dismiss" });
		expect(bare.calls).toEqual([{ path: "/api/items/Q-aaaa/dismiss", body: {} }]);
		expect(bare.toast.textContent).toContain("nothing was answered");
		const noted = await page(() => ({ items: [item("Q-aaaa")] }));
		await noted.type("note", " handled in the thread ");
		await noted.tap({ act: "dismiss" });
		expect(noted.calls).toEqual([{ path: "/api/items/Q-aaaa/dismiss", body: { note: "handled in the thread" } }]);
	});
});

describe("on a phone, from an item's own screen", () => {
	test("settling an item goes on to the next one, or back to the list when none is left", async () => {
		let items = [item("Q-aaaa"), item("Q-bbbb")];
		const p = await page(() => ({ items }), { path: "/item/Q-aaaa" });
		expect(rowOf(p.html())).toEqual(BUTTONS);
		items = [item("Q-bbbb")];
		await p.tap({ act: "dismiss" });
		expect(p.calls.map((c) => c.path)).toEqual(["/api/items/Q-aaaa/dismiss"]);
		expect(p.went).toContain("/item/Q-bbbb");
		items = [];
		await p.tap({ act: "snooze-panel" });
		await p.tap({ snooze: "hour" });
		expect(p.went.at(-1)).toBe("/");
	});
});
