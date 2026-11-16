import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { createApp } from "../web/app.ts";
import type { Linker } from "../web/thread-links.ts";
import { memoryCapability } from "./capability.ts";
import { memStore } from "./store.ts";

export type S = ReturnType<ReturnType<typeof useWebViewKeyFixtures>["setup"]>;

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebViewKeyFixtures() {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const HOST = "127.0.0.1:3791";

	const ORIGIN = `http://${HOST}`;

	const NOW = 1_800_000_000_000;

	const LATER = new Date(NOW + 3_600_000).toISOString();

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (id: string): Question => ({
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
	});

	const IDS = ["Q-abcd", "Q-efgh", "Q-ijkl", "Q-mnop", "Q-qrst"];

	function setup(links?: Linker) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-viewkey-`);
		dirs.push(root);
		for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
		mkdirSync(`${root}/state/evidence/Q-abcd`, { recursive: true });
		writeFileSync(`${root}/state/evidence/Q-abcd/shot.png`, "PNGBYTES");
		const store = memStore();
		for (const id of IDS) askQuestion(store, question(id));
		const logs: Record<string, unknown>[] = [];
		const cardAnswers: unknown[] = [];
		const card = {
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
		};
		const page = newToken();
		const view = newToken();
		const cap = memoryCapability(page, { now: NOW }, view);
		const app = createApp({
			capability: cap.capability,
			store,
			state: `${root}/state`,
			log: (event, data) => logs.push({ event, ...data }),
			hosts: [HOST],
			staticDir: root,
			now: () => NOW,
			...(links ? { links } : {}),
			mirror: {
				list: () => [card],
				answer: async (...a: unknown[]) => {
					cardAnswers.push(a);
					return { status: 200, body: { ok: true, choice: "A" } };
				},
			},
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
		return { app, store, logs, page, view, cardAnswers, send };
	}

	const tok = (k: string) => ({ [TOKEN_HEADER]: k });

	const WRITES = (id: string): [string, string, unknown][] => [
		["snooze", `/api/items/${id}/snooze`, { until: LATER }],
		["direction", `/api/items/${id}/direction`, { note: "go with A" }],
		["dismiss", `/api/items/${id}/dismiss`, { note: "done" }],
		["answer", `/api/items/${id}/answer`, { choice: 1 }],
	];

	/**
	 * Every other write or read, each refused to the view key whatever its origin. Evidence is not here: the view key may GET a file its
	 * question lists (src/web/view-key-evidence.test.ts holds what it is still refused there).
	 */
	const REFUSED: [string, string, unknown?][] = [
		["POST", "/api/items/Q-abcd/not-now", {}],
		["POST", "/api/accept-all", { ids: ["Q-abcd"] }],
		["POST", "/api/rulings/R1/confirm", {}],
		["POST", "/api/rulings/R1/edit", { decides: "x" }],
		["POST", "/api/rulings/R1/once", {}],
		["POST", "/api/rulings/R1/retire", {}],
		["POST", "/api/cards/C-0123456789ab/confirm", { choice: 0, sig: "s1" }],
		["POST", "/api/cards/C-0123456789ab/answer", { choice: 0, sig: "s1", challenge: "x" }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, saveRuling: true, rulingWording: "Always merge" }],
		["POST", "/api/items/Q-abcd/answer", { choice: 0, by: "batch" }],
		["GET", "/api/items/Q-abcd"],
		["GET", "/"],
		["GET", "/rulings"],
	];

	return { ORIGIN, LATER, setup, tok, WRITES, REFUSED };
}
