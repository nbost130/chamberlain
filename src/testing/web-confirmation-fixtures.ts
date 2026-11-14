import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingCard } from "../core/adapter-waiting.ts";
import { createApp } from "../web/app.ts";
import { createWaiting } from "../web/waiting.ts";
import { openCapability } from "./capability.ts";
import { createFakeAdapter } from "./fake-adapter.ts";
import { memStore } from "./store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebConfirmationFixtures() {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const HOST = "127.0.0.1:3790";

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const card = (over: Partial<WaitingCard>): WaitingCard => ({
		id: "C-0123456789ab",
		type: "approval",
		server: "fake",
		threadId: "t1",
		threadTitle: "Build",
		requestId: "r1",
		question: "Run this?",
		options: [{ label: "Approve once" }, { label: "Decline" }],
		answerable: true,
		sig: "sig-1",
		command: "rm -rf build",
		...over,
	});

	/** The real card layer over the fake adapter, behind the real app. */
	async function setup(cards: WaitingCard[] = [card({})]) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-confirm-`);
		dirs.push(root);
		const fake = createFakeAdapter();
		fake.cards = cards;
		const clock = { t: Date.parse("2026-11-12T12:00:00Z") };
		const mirror = createWaiting({
			store: memStore(),
			servers: () => [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			skipThreads: () => [],
			log: () => {},
		});
		await mirror.poll();
		const store = memStore();
		const app = createApp({
			capability: openCapability(),
			store,
			state: `${root}/state`,
			log: () => {},
			hosts: [HOST],
			staticDir: root,
			mirror,
			now: () => clock.t,
		});
		const send = (path: string, body: unknown, o: { cookie?: string; origin?: string } = {}) =>
			app.fetch(
				new Request(`http://${HOST}${path}`, {
					method: "POST",
					headers: {
						host: HOST,
						"content-type": "application/json",
						"x-decision-queue": "1",
						...(o.cookie ? { cookie: o.cookie } : {}),
						...(o.origin ? { origin: o.origin } : {}),
					},
					body: JSON.stringify(body),
				}),
			);
		const confirm = (id: string, body: unknown, cookie?: string) => send(`/api/cards/${id}/confirm`, body, { cookie });
		const answer = (id: string, body: unknown, cookie?: string) => send(`/api/cards/${id}/answer`, body, { cookie });
		/** Step one as the page does it: returns the challenge and the session cookie the server set. */
		async function ask(id: string, choice: number, sig: string, cookie?: string) {
			const r = await confirm(id, { choice, sig }, cookie);
			const set = r.headers.get("set-cookie");
			const body = await r.json();
			return {
				status: r.status,
				body,
				challenge: body.challenge as string,
				cookie: cookie ?? set?.split(";")[0],
				setCookie: set,
			};
		}
		return { fake, store, app, clock, mirror, confirm, answer, ask };
	}

	return { HOST, card, setup };
}
