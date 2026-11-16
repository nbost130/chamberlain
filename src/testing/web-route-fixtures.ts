import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WakeTransport } from "../core/delivery/deliver.ts";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import { dbPath } from "../core/store/store.ts";
import { createApp } from "../web/app.ts";
import type { SendToThread } from "../web/waiting.ts";
import { openCapability } from "./capability.ts";
import { testRelay } from "./relay.ts";

type Sent = { server: string; threadId: string; text: string; seed: string };

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebRouteFixtures(makeWake: (url: () => string | undefined, doFetch: typeof fetch) => WakeTransport) {
	const HOST = "127.0.0.1:3790";

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const routed = (id: string, over: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Question ${id}`,
		context: "ctx",
		options: [
			{ label: "Ship the blue one", route: "thread", relay: "Use the blue palette and open the PR." },
			{ label: "Hold", detail: "re-plan first" },
		],
		recommended: 0,
		thread: "Mobile app",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-09T10:00:00.000Z",
		...over,
	});

	function setup(
		opts: { send?: (n: number) => { ok: boolean; detail: string } | Error; root?: string; noSender?: boolean } = {},
	) {
		const root = opts.root ?? mkdtempSync(`${tmpdir()}/chamberlain-route-`);
		const state = `${root}/state`;
		const store = openStore(dbPath(state));
		if (!opts.root) dirs.push(root);
		const posts: { deliveryId: string; message: string }[] = [];
		const sends: Sent[] = [];
		const logs: { event: string; data?: Record<string, unknown> }[] = [];
		const { drain } = testRelay(
			store,
			makeWake(() => "http://webhook.test/wake", (async (_u: string, init: RequestInit) => {
				posts.push(JSON.parse(String(init.body)));
				return new Response(null, { status: 202 });
			}) as unknown as typeof fetch),
		);
		const sendToThread: SendToThread = async (server, threadId, text, seed) => {
			sends.push({ server, threadId, text, seed });
			const r = opts.send ? opts.send(sends.length) : { ok: true, detail: `sent to ${server}:${threadId}` };
			if (r instanceof Error) throw r;
			return r;
		};
		const page = createApp({
			capability: openCapability(),
			store,
			state,
			log: (event, data) => logs.push({ event, data }),
			hosts: [HOST],
			staticDir: `${root}/static`,
			...(opts.noSender ? {} : { sendToThread }),
		});
		const app = {
			...page,
			idle: async () => {
				await page.idle();
				await drain();
			},
		};
		const tick = async () => {
			await page.recover();
			await drain();
		};
		const post = (path: string, body: unknown) =>
			app.fetch(
				new Request(`http://${HOST}${path}`, {
					method: "POST",
					headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1" },
					body: JSON.stringify(body),
				}),
			);
		const add = (i: Question) => askQuestion(store, i);
		const answer = async (id: string, body: unknown) => {
			const r = await post(`/api/items/${id}/answer`, body);
			await app.idle();
			return r;
		};
		return { root, store, state, app, add, answer, posts, sends, logs, tick };
	}

	/** The direct sends on record: one relays row per item that took its one send, with how it ended. */
	const relays = (s: { store: ReturnType<typeof openStore> }) =>
		[...s.store.claims.listRelays("queue")].map(([item, r]) => ({ item, ...r }));

	return { routed, setup, relays };
}
