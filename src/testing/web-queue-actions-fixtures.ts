import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { QUEUE, type Question } from "../core/items/questions.ts";
import { appendHeld, HELD } from "../core/ops/afk-held.ts";
import { newToken, TOKEN_HEADER } from "../core/ops/capability.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import { dbPath, type Store } from "../core/store/store.ts";
import { createApp } from "../web/app.ts";
import { memoryCapability } from "./capability.ts";

export type Setup = ReturnType<ReturnType<typeof useWebQueueActionsFixtures>["setup"]>;

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebQueueActionsFixtures() {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const HOST = "127.0.0.1:3790";

	const ORIGIN = `http://${HOST}`;

	const T0 = Date.parse("2026-11-14T12:00:00.000Z");

	const HOUR = 3_600_000;

	const iso = (ms: number) => new Date(ms).toISOString();

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (id: string, over: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Whether the ${id} billing retry runs hourly or daily`,
		context: "ctx",
		options: [{ label: "A · One" }, { label: "B · Two" }],
		recommended: 0,
		thread: "Billing thread",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-14T08:00:00.000Z",
		...over,
	});

	const ROUTES = ["snooze", "unsnooze", "direction", "dismiss"] as const;

	const bodyFor = (route: string) =>
		route === "snooze" ? { until: iso(T0 + 2 * HOUR) } : route === "direction" ? { note: "go with A" } : {};

	/** The page over a real capability and a clock the test moves. `root` rebuilds the page over the disk another setup left: a restart. */
	function setup(opts: { root?: string; now?: { t: number }; sent?: string[] } = {}) {
		const root = opts.root ?? mkdtempSync(`${tmpdir()}/chamberlain-actions-`);
		if (!opts.root) dirs.push(root);
		const store = openStore(dbPath(`${root}/state`));
		const clock = opts.now ?? { t: T0 };
		const token = newToken();
		const cap = memoryCapability(token, { now: T0 });
		const logs: { event: string }[] = [];
		const app = createApp({
			capability: cap.capability,
			store,
			state: `${root}/state`,
			log: (event, data) => logs.push({ event, ...data }),
			hosts: [HOST],
			now: () => clock.t,
			sendToThread: async (server, threadId, message) => {
				opts.sent?.push(`${server}/${threadId}: ${message}`);
				return { ok: true, detail: "sent" };
			},
		});
		const call = (
			method: string,
			path: string,
			o: { origin?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
		) => {
			const headers: Record<string, string> = { host: HOST, ...(o.headers ?? {}) };
			if (o.origin) headers.origin = o.origin;
			if (o.key) headers[TOKEN_HEADER] = o.key;
			if (method === "POST") {
				headers["content-type"] ??= "application/json";
				headers["x-decision-queue"] ??= "1";
			}
			return app.fetch(
				new Request(`${ORIGIN}${path}`, {
					method,
					headers,
					...(method === "POST" ? { body: JSON.stringify(o.body ?? {}) } : {}),
				}),
			);
		};
		/** The full page: the key, from its own origin. */
		const page = (method: string, path: string, body?: unknown) =>
			call(method, path, { origin: ORIGIN, key: token, body });
		const post = (id: string, route: string, body?: unknown) =>
			page("POST", `/api/items/${id}/${route}`, body ?? bodyFor(route));
		const queue = async () =>
			(await (await page("GET", "/api/queue")).json()) as { items: { id: string }[]; snoozed: any[] };
		return { root, store, app, token, cap, clock, logs, call, page, post, queue };
	}

	/** Everything the page could change: items, claims, relays, wakes, holds. A refused request leaves this identical. */
	const world = (store: Store) =>
		JSON.stringify({
			items: store.items.list({ source: QUEUE }),
			claims: store.claims.list(QUEUE),
			wakes: store.wakes.rows("all"),
			held: store.items.list({ source: HELD }),
		});

	const hold = (store: Store, id: string) =>
		appendHeld(store, { thread: "Billing thread", what: `waits on ${id}`, item: id }, new Date(T0 - HOUR));

	/** Every wake the page wrote: outbox rows, then held items (an answer's wake is held until the Steward is idle, hold.ts). */
	const wakes = (s: { store: Store }) =>
		[...s.store.wakes.rows("all"), ...s.store.wakes.held()].map((r) => ({ id: r.deliveryId, message: r.message }));

	return { ORIGIN, T0, HOUR, iso, question, ROUTES, bodyFor, setup, world, hold, wakes };
}
