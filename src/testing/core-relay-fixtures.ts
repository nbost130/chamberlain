import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Gate } from "../core/decide/hold.ts";
import type { WakeTransport } from "../core/delivery/deliver.ts";
import { createOutbox, type WakeResult } from "../core/delivery/deliver.ts";
import type { Relay } from "../core/delivery/relay.ts";
import type { RelayDeps } from "../core/delivery/relay-ctx.ts";
import { RIGHTS_SENT_KEY, rightsEpoch, rightsFirstId, rightsStateKey } from "../core/steward/rights-sent.ts";
import type { Store } from "../core/store/store.ts";
import { testRelayLock } from "./lock.ts";
import { memStore } from "./store.ts";

type RigOptions = {
	store?: Store;
	max?: number;
	rightsNow?: RelayDeps["rightsNow"];
	compact?: WakeTransport;
	rightsInline?: boolean;
	debounceMs?: number;
};

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreRelayFixtures(makeRelay: (d: RelayDeps) => Relay) {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const scratch = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-relay-`);
		dirs.push(d);
		return d;
	};

	/** A world: a store, a clock, a webhook whose answer the test sets, and relays (each a fresh process's) over the same store. */
	function rig(o: RigOptions = {}) {
		const store = o.store ?? memStore();
		const clock = { t: 1_000_000 };
		const posts: { id: string; message: string }[] = [];
		const alarms: string[] = [];
		const events: { event: string; data?: Record<string, unknown> }[] = [];
		const w = {
			ready: true,
			gate: "idle" as Gate,
			answer: async (_id: string): Promise<WakeResult> => ({ ok: true, status: 202 }),
		};
		const relay = (s: Store = store) =>
			makeRelay({
				store: s,
				lock: testRelayLock(s),
				gate: () => w.gate,
				log: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
				alarm: (k) => alarms.push(k),
				now: () => clock.t,
				maxAttempts: o.max ?? 3,
				retryAfterMs: () => 1000,
				...(o.rightsNow ? { rightsNow: o.rightsNow } : {}),
				...(o.compact ? { compact: o.compact } : {}),
				...(o.rightsInline ? { rightsInline: true } : {}),
				...(o.debounceMs !== undefined ? { debounceMs: o.debounceMs } : {}),
				wake: {
					ready: () => w.ready,
					send: async (id, message) => {
						posts.push({ id, message });
						return w.answer(id);
					},
				},
			});
		const outbox = createOutbox({ store, log: () => {}, now: () => clock.t });
		const sweep = (id: string, thread?: string, kind = "sweep") =>
			outbox.deliver(`text of ${id}`, id, { kind, ...(thread ? { thread } : {}) });
		/** A store whose delivered commit fails: a full disk at the one commit that matters. */
		const broken: Store = {
			...store,
			wakes: {
				...store.wakes,
				finish: (id, status, now) => {
					if (status === "delivered") throw Error("SQLITE_FULL: database or disk is full");
					return store.wakes.finish(id, status, now);
				},
			},
		};
		return { store, clock, posts, alarms, events, w, relay, outbox, sweep, broken, ids: () => posts.map((p) => p.id) };
	}

	const H1 = "a".repeat(64);

	const H2 = "b".repeat(64);

	const stamp = { steward: "steward-1", hash: H1, at: "2026-11-13T18:00:00.000Z" };

	const BLOCK = "Decision rights (standing rules):\nmerge green PRs";

	/** The Steward and rights there are now, which the test moves, and how often the relay asked. */
	function world(o: { max?: number } = {}) {
		const st: { steward?: string; session?: string; hash?: string } = { steward: "steward-1", session: "s1", hash: H1 };
		const asked = { n: 0 };
		const rightsNow: RelayDeps["rightsNow"] = async () => {
			asked.n++;
			const now = { ...st };
			return {
				...now,
				wake: (forId: string) => ({
					message: `[chamberlain] rights for ${forId}\n${now.hash ? BLOCK : "unreadable"}`,
					...(now.hash
						? {
								stamp: {
									...(now.steward ? { steward: now.steward } : {}),
									...(now.session ? { session: now.session } : {}),
									hash: now.hash,
									at: "now",
									used: 10,
									full: true as const,
								},
							}
						: {}),
				}),
			};
		};
		const r = rig({ rightsNow, ...(o.max ? { max: o.max } : {}) });
		const record = () => r.store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
		const firstFor = (row: string) =>
			r.store.wakes.rows("all").filter((w) => w.deliveryId.startsWith(`${row}:rights-first:`));
		const key = () => rightsStateKey(st);
		return { ...r, st, asked, record, firstFor, key };
	}

	/** A pointer composed under epoch 0, and full stamps composed under a given epoch. */
	const pointer = { steward: "steward-1", session: "s1", hash: H1, at: "t0", epoch: 0 };

	const fullAt = (epoch: number) => ({
		steward: "steward-1",
		session: "s1",
		hash: H1,
		at: "t0",
		used: 10,
		full: true as const,
		epoch,
	});

	/**
	 * One Steward (steward-1, session s1, rights H1) and a compaction target. The prerequisite's stamp carries the epoch it is composed under, read
	 * from the database as the engine does. Every POST, wakes and compactions alike, goes into one ordered list (`ids`).
	 */
	function compactWorld(o: { store?: Store; compactFails?: { value: boolean } } = {}) {
		const store = o.store ?? memStore();
		const rightsNow: RelayDeps["rightsNow"] = async () => ({
			steward: "steward-1",
			session: "s1",
			hash: H1,
			wake: (forId: string) => ({ message: `[chamberlain] rights for ${forId}`, stamp: fullAt(rightsEpoch(store)) }),
		});
		const compact: WakeTransport = {
			ready: () => true,
			send: async (id) => {
				if (o.compactFails?.value) throw Error("killed between the epoch bump and the compaction POST");
				r.posts.push({ id, message: "" });
				return { ok: true, status: 202 };
			},
		};
		const r = rig({ store, rightsNow, compact });
		const record = () => r.store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
		const prereq = (row: string, epoch: number) =>
			rightsFirstId(row, rightsStateKey({ steward: "steward-1", session: "s1", hash: H1, epoch }));
		/** The full-block row F, whose POST the test holds open until it calls `release`. */
		function fullInFlight() {
			let release!: () => void,
				started = false;
			const open = new Promise<void>((res) => {
				release = res;
			});
			r.w.answer = async (id) => {
				if (id === "F") {
					started = true;
					await open;
				}
				return { ok: true, status: 202 };
			};
			r.outbox.deliver("full block", "F", { kind: "needs_input", rights: [fullAt(0)] });
			return { release, started: () => started };
		}
		const until = async (ok: () => boolean) => {
			for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(5);
			expect(ok()).toBe(true);
		};
		return { ...r, record, prereq, fullInFlight, until };
	}

	return { scratch, rig, H1, H2, stamp, BLOCK, world, pointer, fullAt, compactWorld };
}
