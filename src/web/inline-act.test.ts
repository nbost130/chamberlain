/**
 * The Decisions view acts in place (Q-lxixg99db): little buttons along each card's bottom edge, one tap is one request, no confirmation and no
 * page change, and the card then says what happened or shows the error. Run against the in-memory DOM (src/testing/inline-dom.ts); the server
 * side of the same four writes, and what the view key may not do, is src/web/view-key.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
const item = (over: Record<string, unknown> = {}) => ({
	id: "Q-act1",
	kind: "product",
	title: "Which one?",
	context: "pick",
	options: [{ label: "Ship it", detail: "today" }, { label: "Wait" }, { label: "Cancel" }],
	recommended: 1,
	status: "open",
	createdAt: new Date().toISOString(),
	...over,
});
type Call = { method: string; path: string; body?: any };
const ok = (body: unknown) => ({ status: 200, body });

/** A view of the queue with one open question; `post` answers each POST. */
function view(post: (path: string, body: any) => { status: number; body: unknown }, items: unknown[] = [item()]) {
	const calls: Call[] = [];
	const headers: Record<string, string>[] = [];
	// As the server does, the item leaves the waiting list once a write is recorded (answered, snoozed, dismissed or directed).
	let open = items;
	// and a snoozed one is on the snoozed list, with its time, until it returns
	let put: unknown[] = [];
	const dq = run(() => ({ items: open, snoozed: put, cards: [] }), {
		src: SRC,
		calls,
		headers,
		post: (path, body) => {
			const r = post(path, body);
			if (r.status === 200) {
				if (path.endsWith("/snooze"))
					put = open.map((i) => ({ ...(i as object), snooze: { until: body.until, active: true } }));
				open = [];
			}
			return r;
		},
	});
	return { dq, calls, headers, posts: () => calls.filter((c) => c.method === "POST") };
}
const labels = (dq: El) =>
	dq.all((e) => e.tag === "button" && e.className.split(" ").includes("dq-btn")).map((b) => b.textContent);
const button = (dq: El, text: string) => dq.all((e) => e.tag === "button" && e.textContent === text)[0]!;
const tap = async (dq: El, text: string) => {
	for (const fn of button(dq, text).listeners.click ?? []) await fn();
	await settle();
};
const msg = (dq: El) =>
	dq
		.all(
			(e) =>
				e.className.includes("dq-msg") &&
				!e.className.includes("dq-away") &&
				!e.className.includes("dq-locked") &&
				e.textContent !== "", // a snoozed card's own message line, empty until it is used
		)
		.at(-1)!;

describe("the buttons along a card's bottom edge", () => {
	test("each option, then Snooze, Dismiss and Direction, in one row; the recommended option is marked; no radio, no note box until Direction", async () => {
		const { dq } = view(() => ok({}));
		await settle();
		expect(labels(dq)).toEqual(["Ship it", "Wait", "Cancel", "Snooze", "Dismiss", "Direction"]);
		expect(button(dq, "Wait").className).toContain("rec");
		expect(button(dq, "Ship it").className).not.toContain("rec");
		expect(dq.all((e) => e.tag === "input")).toHaveLength(0);
		expect(dq.all((e) => e.tag === "textarea")[0]!.parent!.style.display).toBe("none");
		expect(dq.textContent).toContain("Ship it: today");
	});
	test("a secret and a card pointer get Snooze only, and no direction field", async () => {
		for (const extra of [{ secret: true }, { cardRequest: "r1" }]) {
			const { dq } = view(() => ok({}), [item(extra)]);
			await settle();
			expect(labels(dq)).toEqual(["Snooze"]);
			expect(dq.all((e) => e.tag === "textarea")).toHaveLength(0);
		}
	});
});

describe("one tap is one request", () => {
	test("an option answers at once: one POST with the choice and nothing else, the card says answered, the buttons go, the count drops", async () => {
		const { dq, posts, headers } = view((_path, body) =>
			ok({ ok: true, choice: body.choice === 0 ? "Ship it" : "Wait", to: "steward" }),
		);
		await settle();
		expect(dq.querySelector(".dq-count")!.textContent).toBe("1 waiting");
		await tap(dq, "Ship it");
		expect(posts()).toEqual([{ method: "POST", path: "/api/items/Q-act1/answer", body: { choice: 0 } }]);
		expect(headers.find((h) => h["x-decision-queue"])).toMatchObject({
			"x-decision-token": "VIEWKEY",
			"x-decision-queue": "1",
		});
		expect(msg(dq).textContent).toBe("Answered: Ship it. Recorded; the wake to the Steward is queued.");
		expect(labels(dq)).toEqual([]);
		expect(dq.querySelector(".dq-count")!.textContent).toBe("clear");
	});
	test("Snooze: one POST for an hour on, the card says when it returns and offers Un-snooze in place (no link to the full page)", async () => {
		const at = Date.now();
		const { dq, posts, calls } = view((_p, body) => ok({ ok: true, until: body.until }));
		await settle();
		await tap(dq, "Snooze");
		expect(posts()).toHaveLength(1);
		expect(posts()[0]).toMatchObject({ path: "/api/items/Q-act1/snooze" });
		const until = Date.parse(posts()[0]!.body.until);
		expect(until - at).toBeGreaterThanOrEqual(3_600_000);
		expect(until - at).toBeLessThan(3_600_000 + 5_000);
		expect(posts()[0]!.body.until).toEndWith("Z");
		expect(msg(dq).textContent).toStartWith("Snoozed. It returns ");
		expect(dq.all((e) => e.tag === "a" && e.href.includes("/item/"))).toEqual([]);
		// the Snoozed section follows at once: the view read the queue again
		expect(calls.filter((c) => c.path === "/api/queue").length).toBeGreaterThan(1);
		// and Un-snooze is one more tap, in place
		await tap(dq, "Un-snooze");
		expect(posts()[1]).toMatchObject({ path: "/api/items/Q-act1/unsnooze", body: {} });
	});
	test("Dismiss: one POST, no confirmation (the view has no dialog to call), the card says dismissed and nothing was answered", async () => {
		const { dq, posts } = view(() => ok({ ok: true, kind: "dismissed" }));
		await settle();
		await tap(dq, "Dismiss");
		expect(posts()).toEqual([{ method: "POST", path: "/api/items/Q-act1/dismiss", body: {} }]);
		expect(msg(dq).textContent).toBe("Dismissed. It is off the queue and nothing was answered.");
		expect(labels(dq)).toEqual([]);
	});
	test("Direction: the first tap opens a field in the same card and sends nothing; Send with no text says so; Send with text is the one request", async () => {
		const { dq, posts } = view(() => ok({ ok: true, kind: "direction" }));
		await settle();
		const field = dq.all((e) => e.tag === "textarea")[0]!;
		await tap(dq, "Direction");
		expect(field.parent!.style.display).toBe("");
		expect(posts()).toEqual([]);
		await tap(dq, "Send direction");
		expect(posts()).toEqual([]);
		expect(msg(dq).className).toContain("dq-bad");
		expect(msg(dq).textContent).toContain("Write your direction first");
		field.value = "  go with the second, skip the migration  ";
		await tap(dq, "Send direction");
		expect(posts()).toEqual([
			{ method: "POST", path: "/api/items/Q-act1/direction", body: { note: "go with the second, skip the migration" } },
		]);
		expect(msg(dq).textContent).toBe("Direction sent. The Steward reads your note; no option was chosen.");
		expect(dq.all((e) => e.tag === "textarea")).toHaveLength(0);
	});
	test("a second tap while the first is in flight sends nothing more", async () => {
		const { dq, posts } = view(() => ok({ ok: true, choice: "Wait", to: "steward" }));
		await settle();
		const fns = button(dq, "Wait").listeners.click ?? [];
		await Promise.all([fns[0]!(), fns[0]!()]);
		await settle();
		expect(posts()).toHaveLength(1);
	});
});

describe("an error shows on the card, and the buttons come back", () => {
	for (const [name, status, body, shown] of [
		["already answered elsewhere", 409, { error: "already answered" }, "already answered"],
		["a refusal with no detail", 500, {}, "HTTP 500"],
		[
			"a key that may not do this",
			403,
			{ error: "refused: this key may read the queue" },
			"refused: this key may read the queue",
		],
	] as const) {
		test(`${name}: the message is inline, nothing is marked done, and the tap can be tried again`, async () => {
			let status_: number = status;
			const { dq, posts } = view(() =>
				status_ === 200 ? ok({ ok: true, choice: "Wait", to: "steward" }) : { status: status_, body },
			);
			await settle();
			await tap(dq, "Wait");
			expect(msg(dq).className).toContain("dq-bad");
			expect(msg(dq).textContent).toBe(shown);
			expect(button(dq, "Wait").disabled).toBe(false);
			expect(button(dq, "Snooze").disabled).toBe(false);
			expect(dq.querySelector(".dq-count")!.textContent).toBe("1 waiting");
			status_ = 200;
			await tap(dq, "Wait");
			expect(posts()).toHaveLength(2);
			expect(msg(dq).className).toContain("dq-ok");
		});
	}
	test("a view key that no longer works says so on the card and in the banner", async () => {
		const { dq } = view(() => ({ status: 401, body: "Locked" }));
		await settle();
		await tap(dq, "Dismiss");
		expect(msg(dq).textContent).toContain("this view's key no longer works");
		expect(dq.textContent).toContain("This view's key no longer works");
		expect(button(dq, "Dismiss").disabled).toBe(false);
	});
});

describe("the plain queue view (no ?view=) follows a tap on its snoozed list", () => {
	test("Bring back now: one POST, then the list is read again and the question is back among the waiting ones (Sol's audit, 2026-11-15)", async () => {
		const snoozed = { ...item({ id: "Q-snzp" }), snooze: { until: "2026-11-15T09:00:00.000Z", active: true } };
		let back = false;
		const calls: { method: string; path: string; body?: unknown }[] = [];
		const dq = run(() => (back ? { items: [item({ id: "Q-snzp" })] } : { items: [], snoozed: [snoozed] }), {
			src: "http://queue.test/inline.js?k=VIEWKEY",
			calls,
			post: () => {
				back = true;
				return ok({ ok: true });
			},
		});
		await settle();
		expect(dq.querySelector(".dq-count")!.textContent).toBe("0 waiting");
		await tap(dq, "Bring back now");
		await settle();
		expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/items/Q-snzp/unsnooze"]);
		expect(calls.filter((c) => c.path === "/api/queue")).toHaveLength(2);
		expect(dq.querySelector(".dq-count")!.textContent).toBe("1 waiting");
		expect(dq.all((e) => e.tag === "button" && e.textContent === "Bring back now")).toEqual([]);
	});
});
