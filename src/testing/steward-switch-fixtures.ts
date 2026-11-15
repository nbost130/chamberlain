/**
 * Fixtures for Steward switch protocol v2 tests: mem store + seeded gen1, switch-owned refs (link 0600),
 * FakeWebhook (gated promises), FakeClock. Never touches live conf/state or real webhooks.
 */
import { afterEach } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { writeConfigFile } from "../core/layout.ts";
import { openStore } from "../core/sqlite-store.ts";
import { publishSwitchRef, seedGen1, switchRefName } from "../core/steward-gens.ts";
import type { Store } from "../core/store.ts";
import { memStore } from "./store.ts";

export type FakeClock = { t: number; now: () => number; advance: (ms: number) => void };
type FakeWebhookPost = { url: string; deliveryId: string; message: string };
export type ConfWorld = {
	root: string;
	conf: string;
	state: string;
	stewardThread: string;
	wakeUrl: string;
	compactUrl: string;
};

/** Registers scratch cleanup for the test file that calls it, and returns fixtures. */
export function useStewardSwitchFixtures() {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const scratch = (prefix = "steward-switch-"): string => {
		const d = mkdtempSync(`${tmpdir()}/${prefix}`);
		dirs.push(d);
		return d;
	};

	const fakeClock = (start = 1_700_000_000_000): FakeClock => {
		const c = {
			t: start,
			now: () => c.t,
			advance: (ms: number) => {
				c.t += ms;
			},
		};
		return c;
	};

	const gatedPromise = (): { wait: Promise<void>; release: () => void } => {
		let release!: () => void;
		const wait = new Promise<void>((ok) => {
			release = ok;
		});
		return { wait, release };
	};

	const fakeWebhook = () => {
		const posts: FakeWebhookPost[] = [];
		const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
		const answers = new Map<string, () => { ok: boolean; status?: number; error?: string }>();
		const defaultAnswer = (): { ok: boolean; status?: number } => ({ ok: true, status: 202 });
		return {
			posts,
			gateUrl(url: string) {
				const g = gatedPromise();
				gates.set(url, g);
				return g;
			},
			setAnswer(url: string, f: () => { ok: boolean; status?: number; error?: string }) {
				answers.set(url, f);
			},
			transportFor(url: () => string) {
				return {
					ready: () => Boolean(url()),
					send: async (deliveryId: string, message: string) => {
						const u = url();
						posts.push({ url: u, deliveryId, message });
						const gate = gates.get(u);
						if (gate) {
							gates.delete(u);
							await gate.wait;
						}
						return (answers.get(u) ?? defaultAnswer)();
					},
				};
			},
		};
	};

	const confWorld = (o: { stewardThread?: string } = {}): ConfWorld => {
		const root = scratch();
		const conf = `${root}/conf`;
		const state = `${root}/state`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		mkdirSync(state, { recursive: true, mode: 0o700 });
		mkdirSync(`${conf}/secrets`, { recursive: true, mode: 0o700 });
		const stewardThread = o.stewardThread ?? "thread-g1-steward";
		const wakeUrl = "https://fake.example/hooks/wake-g1";
		const compactUrl = "https://fake.example/hooks/compact-g1";
		writeConfigFile(conf, { threads: { steward: stewardThread }, principal: "Ada" });
		writeFileSync(`${conf}/secrets/wake-url`, `${wakeUrl}\n`, { mode: 0o600 });
		chmodSync(`${conf}/secrets/wake-url`, 0o600);
		writeFileSync(`${conf}/secrets/compact-url`, `${compactUrl}\n`, { mode: 0o600 });
		chmodSync(`${conf}/secrets/compact-url`, 0o600);
		return { root, conf, state, stewardThread, wakeUrl, compactUrl };
	};

	const memStoreSeeded = (conf: string, now = Date.now()): Store => {
		const store = memStore();
		seedGen1(store, conf, now);
		return store;
	};

	const diskStore = (state: string): Store => {
		mkdirSync(state, { recursive: true, mode: 0o700 });
		return openStore(`${state}/chamberlain.db`);
	};

	const writeSwitchRefs = (conf: string, switchId: string, o: { wakeUrl?: string; compactUrl?: string } = {}) => {
		const wakeUrl = o.wakeUrl ?? `https://fake.example/hooks/u-${switchId}`;
		const compactUrl = o.compactUrl ?? `https://fake.example/hooks/c-${switchId}`;
		if (!publishSwitchRef(conf, switchId, "wake", `${wakeUrl}\n`)) throw new Error(`wake ref exists for ${switchId}`);
		if (!publishSwitchRef(conf, switchId, "compact", `${compactUrl}\n`))
			throw new Error(`compact ref exists for ${switchId}`);
		return { wakeUrl, compactUrl };
	};

	const confFingerprint = (conf: string): string => {
		const cfg = existsSync(`${conf}/config.json`) ? readFileSync(`${conf}/config.json`) : Buffer.alloc(0);
		const secretsDir = `${conf}/secrets`;
		const parts: Buffer[] = [cfg];
		if (existsSync(secretsDir)) {
			const walk = (dir: string) => {
				for (const name of readdirSync(dir).sort()) {
					const p = `${dir}/${name}`;
					if (statSync(p).isDirectory()) walk(p);
					else parts.push(Buffer.from(p), readFileSync(p));
				}
			};
			walk(secretsDir);
		}
		return Bun.hash(Buffer.concat(parts)).toString(16);
	};

	const deliverAndLedger = (
		store: Store,
		o: { deliveryId: string; message: string; at: number; gen: number; origin?: "live" | "adopted" },
	): number => {
		store.wakes.enqueue({ deliveryId: o.deliveryId, message: o.message, queuedAt: o.at });
		const row = store.wakes.find(o.deliveryId)!;
		store.wakes.finish(row.id, "delivered", o.at);
		store.steward.insertLedger({ outboxId: row.id, gen: o.gen, origin: o.origin ?? "live" });
		return row.id;
	};

	return {
		scratch,
		fakeClock,
		gatedPromise,
		fakeWebhook,
		confWorld,
		memStoreSeeded,
		diskStore,
		publishSwitchRef,
		writeSwitchRefs,
		confFingerprint,
		deliverAndLedger,
		refNames: (id: string) => ({
			wakeRef: switchRefName(id, "wake"),
			compactRef: switchRefName(id, "compact"),
		}),
	};
}
