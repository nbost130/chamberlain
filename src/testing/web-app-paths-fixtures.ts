import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import { dbPath, type Store } from "../core/store/store.ts";
import { createApp } from "../web/app.ts";
import type { SendToThread } from "../web/waiting.ts";
import { openCapability } from "./capability.ts";

type Logged = { event: string; data?: Record<string, unknown> };

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebAppPathsFixtures() {
	const HOST = "127.0.0.1:3790";

	/** The page's own origin: its own scripts send it, and it is what gives a request the page's full authority (a request with no Origin is restricted). */
	const ORIGIN = `http://${HOST}`;

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (id: string, over: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Question ${id}`,
		context: "ctx",
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		thread: "Mobile app",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-09T10:00:00.000Z",
		...over,
	});

	/** The app over a scratch store. `wrap` can swap in a store that fails on purpose. */
	function setup(opts: { wrap?: (s: Store) => Store; send?: SendToThread } = {}) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-apppaths-`);
		dirs.push(root);
		const real = openStore(dbPath(`${root}/state`));
		const store = opts.wrap ? opts.wrap(real) : real;
		const logs: Logged[] = [];
		const app = createApp({
			capability: openCapability(),
			store,
			state: `${root}/state`,
			log: (event, data) => logs.push({ event, data }),
			hosts: [HOST],
			staticDir: `${root}/static`,
			...(opts.send ? { sendToThread: opts.send } : {}),
		});
		const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
			app.fetch(
				new Request(`http://${HOST}${path}`, {
					method,
					headers: {
						host: HOST,
						origin: ORIGIN,
						"content-type": "application/json",
						"x-decision-queue": "1",
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		const post = (path: string, body: unknown) => call("POST", path, body);
		const get = (path: string, headers: Record<string, string> = {}) =>
			app.fetch(new Request(`http://${HOST}${path}`, { headers: { host: HOST, origin: ORIGIN, ...headers } }));
		const asked = (q: Question) => askQuestion(real, q);
		return { real, store, app, logs, post, get, call, asked };
	}

	const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as unknown });

	return { question, setup, read };
}
