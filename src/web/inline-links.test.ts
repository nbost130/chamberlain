/**
 * No dead-end links (Nathan, 2026-11-15, on his phone: a waiting card's "Open the queue page" opened "/" with no key, which shows "This page needs its
 * link"). Every link the Decisions view renders, in every state it can be in, is followed here against the real handler as a phone's in-app browser
 * would follow it: a tap, no cookie, no header, nothing but the address. None may land on the needs-its-link page, nor on any refusal. An app link
 * (T3's phone app, the view as the top document) is the app's own, and an outside link leaves the page: neither is ours to follow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { memoryCapability } from "../testing/capability.ts";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";
import type { Linker } from "./thread-links.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3794";
const ORIGIN = `http://${HOST}`;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const app = (id: string) => `t3code://threads/env-home/${id}`;
/** Every thread has a link, as on a server whose environment is known. */
const links: Linker = {
	link: () => undefined,
	target: (_s, id) => app(id),
	openPath: (s, id) => `/open/${encodeURIComponent(s)}/${encodeURIComponent(id)}`,
	appLink: (_s, id) => app(id),
};
const question = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Question ${id}`,
	context: "x",
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	thread: "t",
	server: "main",
	threadId: `th-${id}`,
	createdAt: "2026-11-15T10:00:00.000Z",
	...over,
});
const card = (id: string, type: string, over: Record<string, unknown> = {}) => ({
	id,
	type,
	server: "builder",
	threadId: `bt-${id}`,
	threadTitle: `Builder ${id}`,
	requestId: `r-${id}`,
	header: "Which schema?",
	question: "Pick one",
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	answerable: true,
	sig: `sig-${id}`,
	...over,
});

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-links-`);
	dirs.push(root);
	const state = `${root}/state`;
	mkdirSync(`${state}/evidence/Q-evid`, { recursive: true });
	writeFileSync(`${state}/evidence/Q-evid/shot.png`, "PNGBYTES");
	for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
	const store = memStore();
	askQuestion(
		store,
		question("Q-evid", {
			evidence: [
				{ type: "image", path: "shot.png", caption: "a shot" },
				{ type: "link", url: "https://example.com/spec", caption: "the spec" },
			],
		}),
	);
	askQuestion(store, question("Q-snzz"));
	askQuestion(store, question("Q-scrt", { secret: true, options: [] }));
	askQuestion(store, question("Q-cptr", { cardRequest: "req-1" }));
	const view = newToken();
	const cards = [
		card("C-000000000001", "question"),
		card("C-000000000002", "approval", { command: "rm -rf build" }),
		card("C-000000000003", "secret", { answerable: false, why: "Enter it in its thread." }),
	];
	const a = createApp({
		capability: memoryCapability(newToken(), { now: Date.now() }, view).capability,
		store,
		state,
		log: () => {},
		hosts: [HOST],
		staticDir: `${root}/`,
		links,
		mirror: { list: () => cards as never, answer: async () => ({ status: 200, body: { ok: true } }) },
	});
	const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
		a.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					host: HOST,
					...headers,
					...(method === "POST" ? { "content-type": "application/json", "x-decision-queue": "1" } : {}),
				},
				...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
			}),
		);
	return { app: a, view, send };
}
type S = ReturnType<typeof setup>;

/** The frame's reads, made with the view key as inline.js makes them. */
const read = async (s: S, path: string) =>
	(await s.send("GET", path, { [TOKEN_HEADER]: s.view, origin: "null" })).json();

/** Follows one link as a phone's in-app browser would: a tap, nothing but the address. */
async function follow(s: S, href: string) {
	const r = await s.app.fetch(
		new Request(href, { headers: { host: HOST, "sec-fetch-user": "?1" }, redirect: "manual" }),
	);
	const text = await r.text();
	return { status: r.status, locked: text.includes("This page needs its link"), location: r.headers.get("location") };
}

/** Every link the view shows, in each state worth showing: the queue, one question, after a snooze, and the one-question view of a snoozed one. */
async function everyLink(s: S, top: boolean): Promise<string[]> {
	const win = top
		? (() => {
				const w: { parent?: unknown } = {};
				w.parent = w;
				return w;
			})()
		: { parent: {} };
	const k = encodeURIComponent(s.view);
	const later = new Date(Date.now() + 3_600_000).toISOString();
	const hrefs: string[] = [];
	const collect = (dq: El) => hrefs.push(...dq.all((e) => e.tag === "a").map((e) => e.href));
	const queue = () => read(s, "/api/queue");
	const recent = () => read(s, "/api/recent");
	let q = await queue();
	for (const src of [
		`${ORIGIN}/inline.js?view=decisions&k=${k}`,
		`${ORIGIN}/inline.js?k=${k}`,
		`${ORIGIN}/inline.js?item=Q-evid&k=${k}`,
	]) {
		const dq = run(() => q, { src, window: win, recent: () => ({ items: [] }) });
		await settle();
		collect(dq);
		// after a tap on Snooze: what the card offers then
		const snooze = dq.all((e) => e.tag === "button" && e.textContent === "Snooze")[0];
		if (snooze) {
			const tapped = run(() => q, {
				src,
				window: win,
				post: () => ({ status: 200, body: { ok: true, until: later } }),
			});
			await settle();
			for (const fn of tapped.all((e) => e.tag === "button" && e.textContent === "Snooze")[0]!.listeners.click ?? [])
				await fn();
			await settle();
			collect(tapped);
		}
	}
	// a snoozed question, in the Decisions view's Snoozed tab and in its own one-question view
	expect((await s.send("POST", "/api/items/Q-snzz/snooze", { [TOKEN_HEADER]: s.view }, { until: later })).status).toBe(
		200,
	);
	q = await queue();
	const r = await recent();
	for (const src of [`${ORIGIN}/inline.js?view=decisions&k=${k}`, `${ORIGIN}/inline.js?item=Q-snzz&k=${k}`]) {
		const dq = run(() => q, { src, window: win, recent: () => r });
		await settle();
		collect(dq);
	}
	return [...new Set(hrefs)];
}

for (const [label, top] of [
	["in a frame (T3's web and desktop clients)", false],
	["as the top document (T3's phone app)", true],
] as const) {
	describe(`every link the Decisions view shows works, ${label}`, () => {
		test("followed with a tap and nothing else, none lands on the needs-its-link page or a refusal", async () => {
			const s = setup();
			const hrefs = await everyLink(s, top);
			expect(hrefs.length).toBeGreaterThan(3);
			const ours = hrefs.filter((h) => h.startsWith(ORIGIN));
			const apps = hrefs.filter((h) => h.startsWith("t3code://"));
			const outside = hrefs.filter((h) => /^https?:\/\//.test(h) && !h.startsWith(ORIGIN));
			// nothing else: no relative link, no other scheme
			expect(hrefs.filter((h) => !ours.includes(h) && !apps.includes(h) && !outside.includes(h))).toEqual([]);
			if (top) expect(apps.length).toBeGreaterThan(0);
			for (const href of ours) {
				const r = await follow(s, href);
				expect([href, r.locked, [200, 303].includes(r.status)]).toEqual([href, false, true]);
				if (r.status === 303) expect([href, r.location?.startsWith("t3code://")]).toEqual([href, true]);
			}
		});
	});
}
