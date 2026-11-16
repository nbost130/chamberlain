import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { createApp } from "../web/app.ts";
import { memoryCapability } from "./capability.ts";
import { memStore } from "./store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebCapabilityFixtures() {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const HOST = "127.0.0.1:3790";

	const ORIGIN = `http://${HOST}`;

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function setup() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-capweb-`);
		dirs.push(root);
		for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
		const store = memStore();
		const item: Question = {
			id: "Q-abcd",
			kind: "product",
			title: "Pick one",
			context: "secret context",
			options: [{ label: "A" }, { label: "B" }],
			recommended: 0,
			thread: "t",
			server: "main",
			createdAt: "2026-11-09T10:00:00.000Z",
		};
		askQuestion(store, item);
		// a second question with a real evidence file, so that "served" means a file's bytes and not a 404
		mkdirSync(`${root}/state/evidence/Q-evid`, { recursive: true });
		writeFileSync(`${root}/state/evidence/Q-evid/shot.png`, "PNGBYTES");
		askQuestion(store, {
			...item,
			id: "Q-evid",
			title: "With a picture",
			evidence: [{ type: "image", path: "shot.png", caption: "a shot" }],
		});
		const logs: unknown[] = [];
		const token = newToken();
		const cap = memoryCapability(token, { now: 1_800_000_000_000 });
		const app = createApp({
			capability: cap.capability,
			store,
			state: `${root}/state`,
			log: (event, data) => logs.push({ event, ...data }),
			hosts: [HOST],
			staticDir: root,
		});
		const get = (path: string, headers: Record<string, string> = {}) =>
			app.fetch(new Request(`${ORIGIN}${path}`, { headers: { host: HOST, ...headers } }));
		const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
			app.fetch(
				new Request(`${ORIGIN}${path}`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1", ...headers },
					body: JSON.stringify(body),
				}),
			);
		return { app, store, logs, token, cap, get, post, item };
	}

	const key = (t: string) => ({ [TOKEN_HEADER]: t });

	const cookieFrom = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

	return { HOST, ORIGIN, setup, key, cookieFrom };
}
