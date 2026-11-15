/**
 * The VIEW key and evidence, against the real handler (createApp) with a real capability. The Decisions view shows a question's images and video
 * the way the full page does, so the view key may GET `/evidence/<id>/<name>` (a header, or `?k=` since an `<img>` cannot send one), and that is
 * all it gains: only a name the question lists, only from that question's own folder, only for a question its own reads already show it (the
 * open and snoozed queue, the recent answers), never a cookie, never a page, never one item's read. The regression this restores: 3b28f2b gave
 * posts the view key in place of the page key and left evidence off its list, so the inline images broke.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { newToken, TOKEN_HEADER } from "../core/capability.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { memoryCapability } from "../testing/capability.ts";
import { run, settle } from "../testing/inline-dom.ts";
import { memStore } from "../testing/store.ts";
import { createApp } from "./app.ts";

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";
const HOST = "127.0.0.1:3793";
const ORIGIN = `http://${HOST}`;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string, evidence: Question["evidence"]): Question => ({
	id,
	kind: "product",
	title: `Question ${id}`,
	context: "x",
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	thread: "t",
	server: "main",
	createdAt: "2026-11-09T10:00:00.000Z",
	evidence,
});
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const OLD = Array.from({ length: 21 }, (_, n) => `Q-old${String(n).padStart(2, "0")}`);

function setup() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-viewkey-ev-`);
	dirs.push(root);
	const state = `${root}/state`;
	const file = (id: string, name: string, bytes: string) => {
		mkdirSync(`${state}/evidence/${id}`, { recursive: true });
		writeFileSync(`${state}/evidence/${id}/${name}`, bytes);
	};
	// Q-evid lists a shot and a clip; its folder also holds a file it does not list. Q-othr lists its own file, and holds a copy of Q-evid's name.
	file("Q-evid", "shot.png", "PNGBYTES");
	// a real image: a 1x1 PNG, as an ERD screenshot would be
	mkdirSync(`${state}/evidence/Q-evid`, { recursive: true });
	writeFileSync(`${state}/evidence/Q-evid/erd.png`, PNG);
	file("Q-evid", "clip.mp4", "MP4BYTES");
	file("Q-evid", "secret.png", "UNLISTED");
	file("Q-othr", "other.png", "OTHERPNG");
	file("Q-othr", "shot.png", "OTHERSHOT");
	file("Q-snzd", "s.png", "SNOOZEDPNG");
	for (const id of OLD) file(id, "o.png", `OLD-${id}`);
	const store = memStore();
	askQuestion(
		store,
		question("Q-evid", [
			{ type: "image", path: "shot.png", caption: "a shot" },
			{ type: "image", path: "erd.png", caption: "the ERD" },
			{ type: "video", path: "clip.mp4", caption: "a demo" },
			{ type: "link", url: "https://example.com/spec" },
		]),
	);
	askQuestion(store, question("Q-othr", [{ type: "image", path: "other.png" }]));
	askQuestion(store, question("Q-snzd", [{ type: "image", path: "s.png" }]));
	for (const id of OLD) askQuestion(store, question(id, [{ type: "image", path: "o.png" }]));
	const page = newToken();
	const view = newToken();
	const clock = { now: Date.now() };
	const cap = memoryCapability(page, clock, view);
	const app = createApp({
		capability: cap.capability,
		store,
		state,
		log: () => {},
		hosts: [HOST],
		staticDir: root,
		now: () => clock.now,
	});
	const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
		app.fetch(
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
	return { app, page, view, clock, send };
}
type S = ReturnType<typeof setup>;
const tok = (k: string) => ({ [TOKEN_HEADER]: k });
const viaLink = (s: S, path: string) => `${path}?k=${encodeURIComponent(s.view)}`;
const ORIGINS = [
	["no Origin (how an <img> in the frame fetches)", {}],
	["Origin: null (T3's frame)", { origin: "null" }],
	["the page's own Origin", { origin: ORIGIN }],
] as const;

describe("the view key reads a listed evidence file", () => {
	for (const [label, origin] of ORIGINS) {
		test(`${label}: an image and a video, by header and by ?k=, with no cookie`, async () => {
			const s = setup();
			for (const [path, type, bytes] of [
				["/evidence/Q-evid/shot.png", "image/png", "PNGBYTES"],
				["/evidence/Q-evid/clip.mp4", "video/mp4", "MP4BYTES"],
			] as const) {
				for (const r of [
					await s.send("GET", path, { ...tok(s.view), ...origin }),
					await s.send("GET", viaLink(s, path), origin),
				]) {
					expect([path, r.status, r.headers.get("content-type"), r.headers.get("set-cookie")]).toEqual([
						path,
						200,
						type,
						null,
					]);
					expect(await r.text()).toBe(bytes);
				}
			}
		});
	}
	test("a snoozed question's file (the Snoozed tab shows it) and a recently answered one's (Recent shows it)", async () => {
		const s = setup();
		const later = new Date(s.clock.now + 3_600_000).toISOString();
		expect((await s.send("POST", "/api/items/Q-snzd/snooze", tok(s.view), { until: later })).status).toBe(200);
		expect((await s.send("POST", "/api/items/Q-othr/dismiss", tok(s.view), {})).status).toBe(200);
		await s.app.idle();
		expect(await (await s.send("GET", viaLink(s, "/evidence/Q-snzd/s.png"))).text()).toBe("SNOOZEDPNG");
		expect(await (await s.send("GET", viaLink(s, "/evidence/Q-othr/other.png"))).text()).toBe("OTHERPNG");
	});
});

describe("and nothing more", () => {
	for (const [label, origin] of ORIGINS) {
		test(`${label}: a name the question does not list, another question's folder, a climb out: refused, no bytes`, async () => {
			const s = setup();
			for (const path of [
				"/evidence/Q-evid/secret.png", // on disk in its folder, not listed
				"/evidence/Q-othr/shot.png", // the name Q-evid lists, in Q-othr's folder, which does not list it
				"/evidence/Q-evid/other.png", // Q-othr's name, asked for under Q-evid
				"/evidence/Q-othr/..%2FQ-evid%2Fsecret.png",
				"/evidence/Q-evid/%2e%2e",
				"/evidence/Q-none/shot.png",
			]) {
				for (const r of [
					await s.send("GET", path, { ...tok(s.view), ...origin }),
					await s.send("GET", viaLink(s, path), origin),
				]) {
					const text = await r.text();
					// 404 from the evidence rules; a climb the URL parser folds away ("%2e%2e") is no evidence path at all: refused by the list (403, or 401 for ?k=)
					expect([path, [401, 403, 404].includes(r.status), r.headers.get("set-cookie")]).toEqual([path, true, null]);
					for (const b of ["PNGBYTES", "UNLISTED", "OTHERSHOT", "OTHERPNG"]) expect(text.includes(b)).toBe(false);
				}
			}
		});
	}
	test("a question its reads no longer show (answered, past the recent twenty): refused to the view key, served to the page's own cookie", async () => {
		const s = setup();
		for (const id of OLD) expect((await s.send("POST", `/api/items/${id}/dismiss`, tok(s.view), {})).status).toBe(200);
		await s.app.idle();
		const recent = (await (await s.send("GET", "/api/recent", tok(s.view))).json()) as { items: { id: string }[] };
		const shown = recent.items.map((i) => i.id);
		const gone = OLD.filter((id) => !shown.includes(id));
		expect([shown.length, gone.length]).toEqual([20, 1]);
		const oldest = gone[0]!;
		const listed = shown[0]!;
		expect((await s.send("GET", viaLink(s, `/evidence/${oldest}/o.png`))).status).toBe(404);
		expect((await s.send("GET", `/evidence/${oldest}/o.png`, tok(s.view))).status).toBe(404);
		expect(await (await s.send("GET", viaLink(s, `/evidence/${listed}/o.png`))).text()).toBe(`OLD-${listed}`);
		const link = await s.send("GET", `/?k=${encodeURIComponent(s.page)}`);
		const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0]!;
		const full = await s.send("GET", `/evidence/${oldest}/o.png`, { cookie, "sec-fetch-site": "same-origin" });
		expect([full.status, await full.text()]).toEqual([200, `OLD-${oldest}`]);
	});
	test("the evidence it may fetch opens nothing else: one item's read, a page, a POST to the file, a wrong key", async () => {
		const s = setup();
		expect((await s.send("GET", "/api/items/Q-evid", tok(s.view))).status).toBe(403);
		for (const p of ["/item/Q-evid", "/", "/api/items/Q-evid"]) {
			const r = await s.send("GET", viaLink(s, p));
			expect([p, r.status, r.headers.get("set-cookie")]).toEqual([p, 401, null]);
		}
		expect((await s.send("POST", "/evidence/Q-evid/shot.png", tok(s.view), {})).status).toBe(403);
		expect((await s.send("GET", `/evidence/Q-evid/shot.png?k=${s.view.slice(0, -1)}x`)).status).toBe(401);
		// the page key in a header with no Origin is still the old inline list, which never reads evidence
		expect((await s.send("GET", "/evidence/Q-evid/shot.png", tok(s.page))).status).toBe(403);
	});
});

describe("the regression 3b28f2b made: the inline card's own image address, fetched as the frame's <img> fetches it", () => {
	test("the Decisions view, fed the real queue, points its <img> and its full-size link at the file, and the server serves the PNG to that address", async () => {
		const s = setup();
		// the frame's read of the queue, with the view key in its header, as inline.js makes it
		const queue = await (await s.send("GET", "/api/queue", { ...tok(s.view), origin: "null" })).json();
		const dq = run(() => queue, { src: `${ORIGIN}/inline.js?view=decisions&k=${encodeURIComponent(s.view)}` });
		await settle();
		const img = dq.all((e) => e.tag === "img" && e.alt === "the ERD")[0]!;
		expect(img.src).toBe(`${ORIGIN}/evidence/Q-evid/erd.png?k=${encodeURIComponent(s.view)}`);
		expect(img.parent?.tag).toBe("a");
		expect(img.parent?.href).toBe(img.src);
		// an <img> sends no Origin and no header of ours: only its address
		const r = await s.app.fetch(new Request(img.src, { headers: { host: HOST, "sec-fetch-dest": "image" } }));
		expect([r.status, r.headers.get("content-type"), r.headers.get("set-cookie")]).toEqual([200, "image/png", null]);
		expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
		// and the card's video too
		const video = dq.all((e) => e.tag === "video")[0]!;
		const v = await s.app.fetch(new Request(video.src, { headers: { host: HOST } }));
		expect([v.status, await v.text()]).toEqual([200, "MP4BYTES"]);
		// the card shows each caption, as the full page does
		for (const c of ["the ERD", "a shot", "a demo"]) expect(dq.textContent).toContain(c);
	});
});
