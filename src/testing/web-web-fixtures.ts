import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WakeTransport } from "../core/deliver.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { addInForce } from "../core/rulings.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath } from "../core/store.ts";
import { createApp } from "../web/app.ts";
import { openCapability } from "./capability.ts";
import { testRelay } from "./relay.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebWebFixtures(makeWake: (url: () => string | undefined, doFetch: typeof fetch) => WakeTransport) {
	const HOST = "127.0.0.1:3790";

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const item = (id: string, over: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Question ${id}`,
		context: "ctx",
		options: [{ label: "A · One" }, { label: "B · Two" }],
		recommended: 0,
		proposedRuling: "Lead with a photo",
		thread: "Mobile app",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-09T10:00:00.000Z",
		...over,
	});

	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	/**
	 * A state directory with its database, a webhook that counts what it receives, the app as server.ts wires it, and the daemon's relay
	 * (unless `relay: false`: no daemon running). `app.idle()` waits for the page and then lets the relay run. Pass `root` to build fresh
	 * instances over the disk another setup left: a restart.
	 */
	function setup(opts: { status?: (n: number) => number; root?: string; relay?: boolean; now?: () => number } = {}) {
		const root = opts.root ?? mkdtempSync(`${tmpdir()}/chamberlain-web-`);
		const state = `${root}/state`;
		const store = openStore(dbPath(state));
		if (!opts.root) {
			dirs.push(root);
			addInForce(store, {
				words: "you can handle all merge conflicts",
				decides: "Merge conflicts are the Steward's.",
				source: "chat",
				how: "stated in chat",
			});
		}
		const posts: { deliveryId: string; message: string }[] = [];
		let n = 0;
		const { drain } = testRelay(
			store,
			makeWake(() => "http://webhook.test/wake", (async (_u: string, init: RequestInit) => {
				posts.push(JSON.parse(String(init.body)));
				return new Response(null, { status: opts.status ? opts.status(++n) : 202 });
			}) as unknown as typeof fetch),
		);
		const page = createApp({
			capability: openCapability(),
			store,
			state,
			log: () => {},
			hosts: [HOST],
			staticDir: `${root}/static`,
			...(opts.now ? { now: opts.now } : {}),
		});
		const app = {
			...page,
			idle: async () => {
				await page.idle();
				if (opts.relay !== false) await drain();
			},
		};
		/** server.ts's heartbeat (the app's recovery), then the daemon's relay. */
		const tick = async () => {
			await page.recover();
			await drain();
		};
		const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
			app.fetch(
				new Request(`http://${HOST}${path}`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1", ...headers },
					body: JSON.stringify(body),
				}),
			);
		const get = (path: string, headers: Record<string, string> = {}) =>
			app.fetch(
				new Request(`http://${HOST}${path}`, {
					// a navigation: openCapability accepts everything, and a request with no cookie and no Origin would be a bare header call
					headers: { host: HOST, "sec-fetch-site": "none", ...headers },
				}),
			);
		const add = (i: Question) => askQuestion(store, i);
		// Only wakes the webhook accepted count; the T3 relay sees a 503 as not received.
		const delivered = () => posts.filter((_, k) => (opts.status ? opts.status(k + 1) : 202) < 300);
		return { root, store, state, app, post, get, add, posts, delivered, tick };
	}

	return { HOST, dirs, item, setup };
}
