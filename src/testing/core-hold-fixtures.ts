import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WakeTransport } from "../core/deliver.ts";
import { createOutbox } from "../core/deliver.ts";
import type { Gate } from "../core/hold.ts";
import { recordAnswerDelivered } from "../core/questions-wake.ts";
import type { Relay } from "../core/relay.ts";
import type { RelayDeps } from "../core/relay-ctx.ts";
import { openStore } from "../core/sqlite-store.ts";
import type { Store } from "../core/store.ts";
import { testRelayLock } from "./lock.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreHoldFixtures(
	makeRelay: (d: RelayDeps) => Relay,
	makeWake: (url: () => string | undefined, doFetch: typeof fetch) => WakeTransport,
) {
	process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

	const MIN = 60_000;

	const TE = (thread: string) => ({ kind: "turn_ended", thread });

	const SWEEP = { kind: "sweep" };

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** One database file, one webhook that counts what it accepted, a clock, and a Steward that is idle until told otherwise. */
	function world() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-hold-`);
		dirs.push(root);
		const w = {
			t: Date.now(),
			gate: "idle" as Gate,
			status: 202,
			accepted: [] as { deliveryId: string; message: string }[],
			onPost: undefined as undefined | (() => void),
		};
		const x = { root, w, store: openStore(`${root}/chamberlain.db`) as Store, snaps: 0 };
		const webhook = (async (_u: string, init: RequestInit) => {
			w.onPost?.();
			if (w.status < 300) w.accepted.push(JSON.parse(String(init.body)));
			return new Response(null, { status: w.status });
		}) as unknown as typeof fetch;
		const events: { event: string; [k: string]: unknown }[] = [];
		/** The daemon's relay (a fresh one is a restart) over the current database. */
		const relay = (extra: { onDelivered?: (id: string) => void } = {}) =>
			makeRelay({
				store: x.store,
				lock: testRelayLock(x.store),
				log: (event, data) => events.push({ event, ...data }),
				alarm: () => {},
				retryAfterMs: () => MIN,
				now: () => w.t,
				gate: () => w.gate,
				wake: makeWake(() => "http://webhook.test/wake", webhook),
				onDelivered: extra.onDelivered ?? ((id) => recordAnswerDelivered(x.store, id)),
			});
		const deliver = (message: string, id: string, meta?: { kind: string; thread?: string }) =>
			createOutbox({ store: x.store, log: () => {}, now: () => w.t }).deliver(message, id, meta);
		const held = () => x.store.wakes.held().map((i) => i.deliveryId);
		/** The database exactly as it stands at a moment (a consistent copy), to restart from. */
		const snap = (): string => {
			const path = `${root}/snap-${++x.snaps}.db`;
			const db = new Database(x.store.path);
			db.run("VACUUM INTO ?", [path]);
			db.close();
			return path;
		};
		const restore = (path: string) => {
			x.store = openStore(path);
		};
		return {
			root,
			w,
			relay,
			deliver,
			held,
			snap,
			restore,
			events,
			store: () => x.store,
			advance: (ms: number) => {
				w.t += ms;
			},
		};
	}

	return { MIN, TE, SWEEP, world };
}
