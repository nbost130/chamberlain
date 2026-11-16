/** waiting, continued: see waiting.test.ts for the overview. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { OptionalCapability } from "../core/adapter/adapter.ts";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { openCapability } from "../testing/capability.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { recordingWake } from "../testing/wake.ts";
import { useWebWaitingFixtures } from "../testing/web-waiting-fixtures.ts";
import { createApp } from "./app.ts";
import { threadSender } from "./waiting.ts";

const { card, pair, mirror } = useWebWaitingFixtures();

describe("the page over an adapter without send: a thread-routed answer falls back to the Steward", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const run = async (capabilities: readonly OptionalCapability[]) => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-page-`);
		dirs.push(root);
		const state = `${root}/state`;
		const store = memStore();
		const fake = createFakeAdapter({ capabilities });
		const { wake, accepted } = recordingWake();
		const { drain } = testRelay(store, wake);
		const app = createApp({
			capability: openCapability(),
			store,
			state,
			log: () => {},
			hosts: ["127.0.0.1:3790"],
			staticDir: root,
			sendToThread: threadSender(() => [pair(fake)]),
		});
		const item: Question = {
			id: "Q-abcd",
			kind: "product",
			title: "Pick a layout",
			context: "",
			options: [{ label: "Photo first", route: "thread", relay: "Lead with the photo." }, { label: "Text first" }],
			thread: "Mobile",
			server: "ws",
			threadId: "t1",
			createdAt: "2026-11-09T10:00:00.000Z",
		};
		askQuestion(store, item);
		const r = await app.fetch(
			new Request("http://127.0.0.1:3790/api/items/Q-abcd/answer", {
				method: "POST",
				headers: { host: "127.0.0.1:3790", "content-type": "application/json", "x-decision-queue": "1" },
				body: JSON.stringify({ choice: 0 }),
			}),
		);
		await app.idle();
		await drain();
		return { fake, accepted, status: r.status, state };
	};
	test("with send: the thread gets it directly and the Steward is not woken", async () => {
		const r = await run(["send"]);
		expect(r.status).toBe(200);
		expect(r.fake.sends).toHaveLength(1);
		expect(r.fake.sends[0]!.text).toContain("Lead with the photo.");
		expect(r.accepted).toEqual([]);
	});
	test("without send: the Steward is woken instead, and told the direct send failed", async () => {
		const r = await run([]);
		expect(r.status).toBe(200);
		expect(r.accepted).toHaveLength(1);
		expect(r.accepted[0]!.message).toContain("direct send failed");
		expect(r.accepted[0]!.message).toContain("cannot send to threads");
	});
});

describe("secretRequest: is a secret question's box still open in its thread?", () => {
	const T0 = Date.parse("2026-11-14T13:00:00.000Z");
	const asked = "2026-11-14T13:00:00.000Z";
	const ask = (over: Record<string, unknown> = {}) => ({ server: "ws", threadId: "t1", createdAt: asked, ...over });
	const secretCard = (over: Partial<WaitingCard> = {}) =>
		card({ type: "secret", answerable: false, options: [], requestId: "turn-item:secret-request:t1:k", ...over });
	const setup = (cards: WaitingCard[], at = T0 + 1000) => {
		const a = createFakeAdapter();
		a.cards = cards;
		let now = at;
		const m = mirror([pair(a)], { now: () => now });
		return { a, m, at: (t: number) => (now = t) };
	};
	test("open while its thread lists a waiting secret request; ended once a later read lists none", async () => {
		const { a, m } = setup([secretCard()]);
		await m.poll();
		expect(m.secretRequest(ask())).toBe("open");
		a.cards = [card()];
		await m.poll();
		expect(m.secretRequest(ask())).toBe("ended");
	});
	test("a pointer question follows its own card: another secret box in the thread does not keep it open", async () => {
		const { m } = setup([secretCard({ requestId: "other" })]);
		await m.poll();
		expect(m.secretRequest(ask({ cardRequest: "turn-item:secret-request:t1:k" }))).toBe("ended");
		expect(m.secretRequest(ask({ cardRequest: "other" }))).toBe("open");
		expect(m.secretRequest(ask())).toBe("open");
	});
	test("a secret box in another thread or on another server, or a question card in this one, is not this box", async () => {
		const { m } = setup([secretCard({ threadId: "t2" }), card({ threadId: "t1" }), secretCard({ server: "lap" })]);
		await m.poll();
		expect(m.secretRequest(ask())).toBe("ended");
	});
	test("unknown until a read that began AFTER the question was asked: a read from before it proves nothing", async () => {
		const { m, at } = setup([], T0 - 1);
		expect(m.secretRequest(ask())).toBeUndefined();
		await m.poll();
		expect(m.secretRequest(ask())).toBeUndefined();
		at(T0);
		await m.poll();
		expect(m.secretRequest(ask())).toBeUndefined();
		at(T0 + 1);
		await m.poll();
		expect(m.secretRequest(ask())).toBe("ended");
	});
	test("unknown when the server cannot be read now, keeps its last cards, or is not mirrored at all", async () => {
		const { a, m } = setup([]);
		await m.poll();
		expect(m.secretRequest(ask())).toBe("ended");
		a.listError = "down";
		await m.poll();
		expect(m.secretRequest(ask())).toBeUndefined();
		const thin = createFakeAdapter({ capabilities: [] });
		const m2 = mirror([pair(thin)], { now: () => T0 + 1000 });
		await m2.poll();
		expect(m2.secretRequest(ask())).toBeUndefined();
		expect(m.secretRequest(ask({ server: "nowhere" }))).toBeUndefined();
	});
	test("unknown with no thread, a thread the mirror never lists, or a question time it cannot read", async () => {
		const { m } = setup([]);
		await m.poll();
		expect(m.secretRequest(ask({ threadId: undefined }))).toBeUndefined();
		expect(m.secretRequest(ask({ threadId: "skipped" }))).toBeUndefined();
		for (const createdAt of ["", "not a date", "9999-99-99"])
			expect([createdAt, m.secretRequest(ask({ createdAt }))]).toEqual([createdAt, undefined]);
	});
});
