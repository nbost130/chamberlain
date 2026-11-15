import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { newToken, TOKEN_HEADER } from "../core/capability.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { createApp } from "../web/app.ts";
import { memoryCapability } from "./capability.ts";
import { memStore } from "./store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebNoOriginFixtures() {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const HOST = "127.0.0.1:3790";

	const ORIGIN = `http://${HOST}`;

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (id: string, extra: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Question ${id}`,
		context: "x",
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		proposedRuling: "Lead with a photo",
		thread: "t",
		server: "main",
		createdAt: "2026-11-09T10:00:00.000Z",
		...extra,
	});

	function setup() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-noorigin-`);
		dirs.push(root);
		for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
		mkdirSync(`${root}/state/evidence/Q-evid`, { recursive: true });
		writeFileSync(`${root}/state/evidence/Q-evid/shot.png`, "PNGBYTES");
		const store = memStore();
		for (const id of ["Q-abcd", "Q-efgh", "Q-ijkl", "Q-mnop", "Q-qrst"]) askQuestion(store, question(id));
		askQuestion(store, question("Q-evid", { evidence: [{ type: "image", path: "shot.png", caption: "a shot" }] }));
		const cardAnswers: unknown[] = [];
		const cards = [
			{
				id: "C-0123456789ab",
				type: "question" as const,
				server: "main",
				threadId: "t",
				threadTitle: "T",
				requestId: "r1",
				question: "Q?",
				options: [{ label: "A" }],
				answerable: true,
				sig: "s1",
			},
			{
				id: "C-ba9876543210",
				type: "approval" as const,
				server: "main",
				threadId: "t",
				threadTitle: "T",
				requestId: "r2",
				question: "Run it?",
				options: [{ label: "Approve once" }, { label: "Decline" }],
				answerable: true,
				sig: "s2",
				command: "rm -rf build",
			},
		];
		const logs: unknown[] = [];
		const page = newToken();
		const view = newToken();
		const cap = memoryCapability(page, { now: 1_800_000_000_000 }, view);
		const app = createApp({
			capability: cap.capability,
			store,
			state: `${root}/state`,
			log: (event, data) => logs.push({ event, ...data }),
			hosts: [HOST],
			staticDir: root,
			mirror: {
				list: () => cards,
				answer: async (id: string, choice: unknown, sig: unknown) => {
					cardAnswers.push([id, choice, sig]);
					return { status: 200, body: { ok: true, choice: "A" } };
				},
			},
		});
		const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
			const h: Record<string, string> = { host: HOST, ...headers };
			if (method === "POST") {
				h["content-type"] = "application/json";
				h["x-decision-queue"] = "1";
			}
			return app.fetch(
				new Request(`${ORIGIN}${path}`, {
					method,
					headers: h,
					...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
				}),
			);
		};
		return { app, store, logs, page, view, cardAnswers, send };
	}

	const tok = (k: string) => ({ [TOKEN_HEADER]: k });

	/** What a request that proves nothing but a header key must be refused, whatever its Origin: the same list for every credential below. */
	const REFUSED: [string, string, unknown?][] = [
		["GET", "/api/items/Q-abcd"],
		["GET", "/api/health"],
		["POST", "/api/accept-all", { ids: ["Q-abcd"] }],
		["POST", "/api/cards/C-0123456789ab/confirm", { choice: 0, sig: "s1" }],
		["POST", "/api/cards/C-0123456789ab/answer", { choice: 0, sig: "s1", challenge: "x" }],
		["POST", "/api/cards/C-ba9876543210/confirm", { choice: 0, sig: "s2" }],
		["POST", "/api/cards/C-ba9876543210/answer", { choice: 0, sig: "s2", challenge: "x" }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true, rulingWording: "Always merge without asking" }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, rulingWording: "Always merge without asking" }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, by: "batch" }],
		["POST", "/api/items/Q-abcd/not-now", {}],
		["POST", "/api/rulings/R1", { status: "retired" }],
		["POST", "/api/rulings", { wording: "x" }],
	];

	/**
	 * The four ways to put off, bring back or settle a question without choosing an option, and a question's listed evidence. The page key with no Origin or
	 * from a frame still gets none of them; the VIEW key gets them (src/web/view-key.ts, view-key.test.ts, view-key-evidence.test.ts), so they are refused
	 * here to the page key alone.
	 */
	const REFUSED_TO_THE_PAGE_KEY: [string, string, unknown?][] = [
		["GET", "/evidence/Q-evid/shot.png"],
		["POST", "/api/items/Q-abcd/snooze", { until: "2099-01-01T00:00:00.000Z" }],
		["POST", "/api/items/Q-abcd/unsnooze", {}],
		["POST", "/api/items/Q-abcd/direction", { note: "go with A" }],
		["POST", "/api/items/Q-abcd/dismiss", { note: "done" }],
	];

	/** The page's static shell: no data in it, so the page key in a header may fetch it; the view key may not. */
	const SHELL = ["/", "/rulings", "/item/Q-abcd"];

	return { ORIGIN, setup, tok, REFUSED, REFUSED_TO_THE_PAGE_KEY, SHELL };
}
