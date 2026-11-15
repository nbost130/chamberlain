/**
 * Parity: whatever the full queue page (static/app.js) SHOWS of a question or a waiting card, the inline Decisions view (static/inline.js) shows too.
 * Nathan, 2026-11-15: "Inline should have everything the web version has." Two locks, so it cannot drift again:
 *   1. the markers: each fixture field carries its own word; every one the page's visible text holds must be in the inline card's text, and every
 *      evidence file and link the page points to, the inline card points to as well;
 *   2. the field list: every field app.js reads off a question, its evidence, its options or a card is either in the fixtures (so lock 1 tests it)
 *      or named below with the reason it is not shown. A field the page starts reading fails here until it is one or the other.
 * What the page does that the view key may not (save a ruling, a note with the answer, Not now, batch accept, answer a card) is not a field: the
 * server refuses those to the view key (src/web/view-key.ts), and the inline card says where they are done.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { addresses, fullCards, fullQuestion, strings, visibleText, webPage } from "../testing/web-parity-fixtures.ts";

const KEY = "view-key-parity-0123456789abcdefghijklmnop";
const BASE = "http://queue.test";
const VIEWS = [
	["the pinned Decisions view", `${BASE}/inline.js?view=decisions&k=${KEY}`],
	["the plain queue view", `${BASE}/inline.js?k=${KEY}`],
] as const;
const inlineText = (dq: El) => dq.textContent.replace(/\s+/g, " ").toLowerCase();
const inlineAddresses = (dq: El) =>
	dq
		.all((e) => Boolean(e.href || e.src))
		.flatMap((e) => [e.href, e.src].filter(Boolean))
		.map((a) => a.replace(`?k=${KEY}`, ""));

/** Every marker in `fixture` the page shows must be in the inline card; and the page must show the ones `mustShow` names (a fixture that went stale). */
async function expectParity(
	queue: Record<string, unknown>,
	pathname: string,
	fixture: unknown,
	mustShow: string[] = [],
) {
	const html = await webPage(queue, pathname);
	const web = visibleText(html);
	for (const m of mustShow) expect([m, web.includes(m.toLowerCase())]).toEqual([m, true]);
	// every string value of the fixture the page shows, whatever it is (a marker, a date, a URL): no filter, so a field the page starts showing as it
	// is cannot slip past
	const shown = [...new Set(strings(fixture))].filter((s) => s.trim().length > 0 && web.includes(s.toLowerCase()));
	const webFiles = addresses(html).filter((a) => a.startsWith("/evidence/") || /^https?:/.test(a));
	for (const [label, src] of VIEWS) {
		const dq = run(() => queue, { src });
		await settle();
		const text = inlineText(dq);
		const missing = shown.filter((s) => !text.includes(s.toLowerCase()));
		expect([label, pathname, missing]).toEqual([label, pathname, []]);
		const at = inlineAddresses(dq);
		const notLinked = webFiles.filter((a) => !at.includes(a.startsWith("/") ? `${BASE}${a}` : a));
		expect([label, pathname, notLinked]).toEqual([label, pathname, []]);
	}
	return { html, web, shown };
}

describe("everything the page shows of a question, the inline card shows", () => {
	test("a question with every field: kind, thread, age, what it blocks, tag, not urgent, not now, context, evidence with captions, links, option details, proposed ruling", async () => {
		const q = fullQuestion();
		const { web, shown } = await expectParity({ items: [q] }, "/item/Q-par1", q, [
			"Title-mark",
			"Cap-img-mark",
			"Cap-vid-mark",
			"Cap-link-mark",
			"Ruling-mark",
			"Det1-mark",
			"Blocks-mark",
			"Tag-mark",
		]);
		expect(shown.length).toBeGreaterThanOrEqual(15);
		// what the page words for it, not a field's own text: the age, "not urgent", "not now", the kind
		const dq = run(() => ({ items: [q] }), { src: VIEWS[0][1] });
		await settle();
		for (const phrase of [
			"asked 5 min ago",
			"not urgent",
			"not now",
			"product review",
			"https://example.com/bare-link-mark",
		])
			expect([phrase, web.includes(phrase), inlineText(dq).includes(phrase)]).toEqual([phrase, true, true]);
	});
	test("with no thread link: where the thread is (server and thread ID), as the page's crumbs say", async () => {
		const q = fullQuestion({ open: undefined });
		await expectParity({ items: [q] }, "/item/Q-par1", q, ["Server-mark", "Threadid-mark"]);
	});
	test("an idea with nothing it blocks: 'no deadline'", async () => {
		const q = fullQuestion({ kind: "idea", blocks: undefined });
		const { web } = await expectParity({ items: [q] }, "/", q);
		const dq = run(() => ({ items: [q] }), { src: VIEWS[0][1] });
		await settle();
		expect([web.includes("no deadline"), inlineText(dq).includes("no deadline")]).toEqual([true, true]);
	});
	test("a secret whose box has closed, and a card pointer", async () => {
		for (const q of [
			fullQuestion({ secret: true, options: [], secretRequest: "ended", evidence: [] }),
			fullQuestion({ cardRequest: "req-1", evidence: [] }),
		]) {
			const { web } = await expectParity({ items: [q] }, "/item/Q-par1", q, ["Title-mark", "Thread-mark"]);
			if ((q as { secret?: boolean }).secret) {
				const dq = run(() => ({ items: [q] }), { src: VIEWS[0][1] });
				await settle();
				expect([web.includes("request expired"), inlineText(dq).includes("request expired")]).toEqual([true, true]);
			}
		}
	});
	test("a snoozed question: its title, its thread and when it returns", async () => {
		const q = fullQuestion({
			id: "Q-snz9",
			snooze: { until: new Date(Date.now() + 3_600_000).toISOString(), active: true },
		});
		await expectParity({ items: [], snoozed: [q] }, "/item/Q-snz9", { title: q.title, thread: q.thread }, [
			"Title-mark",
			"Thread-mark",
		]);
	});
});

describe("everything the page shows of a card waiting in a thread, the inline card shows", () => {
	test("a question card's options and their details, an approval's command, a card the page cannot answer and why", async () => {
		const cards = fullCards();
		await expectParity({ items: [], cards }, "/", cards, [
			"Cthread-mark",
			"Cserver-mark",
			"Cheader-mark",
			"Cquestion-mark",
			"Copt0-mark",
			"Cdet0-mark",
			"Cmd-mark --all",
			"Approve-mark",
			"Why-mark",
		]);
	});
});

describe("the queue's own state the page shows", () => {
	test("test mode, and the Steward's health report", async () => {
		const queue = {
			items: [fullQuestion()],
			testMode: true,
			health: {
				at: new Date().toISOString(),
				verdict: "WATCH",
				report: "Health-report-mark",
				tokens: 1,
				replies: 0,
				breaks: 0,
				selfReads: 0,
				threadRereads: 0,
				unknown: [],
			},
		};
		const { web } = await expectParity(queue, "/", queue.health, ["Health-report-mark", "WATCH"]);
		const dq = run(() => queue, { src: VIEWS[0][1] });
		await settle();
		const bar = "test mode: fixture data. no wake is sent and no question card is touched.";
		expect([web.includes(bar), inlineText(dq).includes(bar)]).toEqual([true, true]);
		expect(dq.all((e) => e.className === "dq-test")[0]!.style.display).toBe("");
	});
});

describe("the field list: every field the page reads is tested above, or named here with why it is not shown", () => {
	const APP = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
	const reads = (v: string) => new Set([...APP.matchAll(new RegExp(`\\b${v}\\.([a-zA-Z_]+)`, "g"))].map((m) => m[1]!));
	const keysOf = (xs: Record<string, unknown>[]) => new Set(xs.flatMap((x) => Object.keys(x)));
	/** Fields the page reads but never shows as text: what each one is for. */
	const NOT_SHOWN: Record<string, string> = {
		id: "the item's address and button targets",
		batchable: "whether Accept-all may take it (a batch, refused to the view key)",
		snooze: "when a snoozed question returns: shown, as a time, on both (the snoozed test above)",
		secretRequest: "'ended' turns into the expired-box sentence (the secret test above)",
		secret: "which panel the question gets",
		cardRequest: "which panel the question gets",
		recommended: "which option is marked recommended (filled on the inline card)",
		test: "not a field: the `i` flag of a /…/i.test(…) regex",
	};
	const NOT_A_CARD: Record<string, string> = {
		at: "a snooze choice's time, not a card field",
		label: "a snooze choice's label, not a card field",
		decision: "the server's confirmation reply, not a card field",
		sig: "the fingerprint an answer must carry, never shown",
		answerable: "whether the page offers the options or says why",
		recommended: "which option is marked recommended",
		id: "the card's address",
		type: "the chip: 'question card', 'approval', … (shown on both as the kind)",
	};
	test("a question's fields", () => {
		const covered = keysOf([fullQuestion()]);
		const unknown = [...reads("i")].filter((f) => !covered.has(f) && !(f in NOT_SHOWN));
		expect(unknown).toEqual([]);
	});
	test("an option's and an evidence item's fields", () => {
		const q = fullQuestion();
		const opt = keysOf(q.options);
		expect([...reads("o")].filter((f) => !opt.has(f))).toEqual([]);
		const ev = keysOf(q.evidence);
		// `e.message` is an Error's, read where a request fails
		expect([...reads("e")].filter((f) => !ev.has(f) && f !== "message")).toEqual([]);
	});
	test("a card's fields", () => {
		const covered = keysOf(fullCards());
		expect([...reads("c")].filter((f) => !covered.has(f) && !(f in NOT_A_CARD))).toEqual([]);
	});
});
