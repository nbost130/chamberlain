/** app-paths, continued: see app-paths.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { appendHeld } from "../core/afk-held.ts";
import type { Store } from "../core/store.ts";
import { useWebAppPathsFixtures } from "../testing/web-app-paths-fixtures.ts";
import type { SendToThread } from "./waiting.ts";

const { question, setup, read } = useWebAppPathsFixtures();

describe("a direct send's bookkeeping", () => {
	const routed = (id: string) =>
		question(id, {
			options: [{ label: "Ship it", route: "thread", relay: "Do it." }, { label: "Hold" }],
		});
	const sendOk: SendToThread = async () => ({ ok: true, detail: "sent" });
	/** The store with one method of `claims` or `items` throwing once `armed()` says so. */
	const failing = (
		store: Store,
		pick: (s: Store) => object,
		method: string,
		armed: () => boolean = () => true,
	): Store =>
		new Proxy(store, {
			get: (t, p, r) => {
				const v = Reflect.get(t, p, r);
				if (p !== "claims" && p !== "items") return v;
				return new Proxy(v as object, {
					get: (tt, pp, rr) => {
						if (v === pick(t) && pp === method && armed())
							return () => {
								throw new Error("disk full\nreally");
							};
						return Reflect.get(tt, pp, rr);
					},
				});
			},
		});

	test("a relay row that cannot be written is logged, and the answer still lands", async () => {
		const s = setup({ send: sendOk, wrap: (st) => failing(st, (x) => x.claims, "finishRelay") });
		s.asked(routed("Q-abcd"));
		const r = await read(await s.post("/api/items/Q-abcd/answer", { choice: 0 }));
		expect(r.status).toBe(200);
		await s.app.idle();
		const failed = s.logs.find((l) => l.event === "relay-record-failed");
		expect(failed?.data).toEqual({ item: "Q-abcd", error: "Error: disk full\nreally" });
		expect(s.logs.find((l) => l.event === "relayed-to-thread")?.data).toMatchObject({
			item: "Q-abcd",
			outcome: "delivered",
			detail: "sent",
		});
	});

	test("a hold that cannot be closed after a delivered send is logged", async () => {
		let sent = false;
		const send: SendToThread = async () => {
			sent = true;
			return { ok: true, detail: "sent" };
		};
		const s = setup({
			send,
			wrap: (st) =>
				failing(
					st,
					(x) => x.items,
					"list",
					() => sent,
				),
		});
		s.asked(routed("Q-abcd"));
		appendHeld(s.real, { thread: "Mobile app", what: "waits", item: "Q-abcd" });
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(s.logs.find((l) => l.event === "held-close-failed")?.data).toEqual({
			item: "Q-abcd",
			error: "Error: disk full\nreally",
		});
	});

	test("a send that cannot start goes to the Steward as a fallback that says why", async () => {
		const s = setup({ send: sendOk, wrap: (st) => failing(st, (x) => x.claims, "startRelay") });
		s.asked(routed("Q-abcd"));
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		const relayed = s.logs.find((l) => l.event === "relayed-to-thread")?.data;
		expect(relayed).toEqual({
			item: "Q-abcd",
			choice: "Ship it",
			server: "main",
			threadId: "thread-1",
			outcome: "failed",
			detail: "the direct send could not start: Error: disk full really",
		});
		expect(s.logs.some((l) => l.event === "wake-queued")).toBe(true);
	});
});
