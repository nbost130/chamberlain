import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { OptionalCapability, ThreadInput } from "../core/adapter/adapter.ts";
import type { WaitingItem } from "../core/adapter/adapter-waiting.ts";
import type { TurnItem } from "../core/decide/decide.ts";
import type { HeldItem } from "../core/decide/hold.ts";
import type { Engine } from "../core/engine/engine.ts";
import type { EngineDeps } from "../core/engine/engine-support.ts";
import type { Store } from "../core/store/store.ts";
import { noAlert } from "./alert.ts";
import { createFakeAdapter, type FakeAdapter } from "./fake-adapter.ts";
import { testRelayLock } from "./lock.ts";
import { memStore } from "./store.ts";

export type Logged = { event: string; [k: string]: unknown };

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreEngineFixtures(makeEngine: (d: EngineDeps) => Engine) {
	const dirs: string[] = [];

	const engines: { stop: () => Promise<void> }[] = [];

	afterEach(async () => {
		for (const e of engines.splice(0)) await e.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** A scratch config and state directory, a fake backend, and an engine on them, fast enough to test (milliseconds, not minutes). */
	function rig(
		o: {
			store?: Store;
			wrap?: (s: Store) => Store;
			adapter?: FakeAdapter;
			steward?: string;
			decisions?: string;
			dry?: boolean;
			capabilities?: readonly OptionalCapability[];
			compactAt?: number;
			housekeeping?: boolean;
			gh?: EngineDeps["gh"];
			ask?: EngineDeps["ask"];
			classifierProvider?: EngineDeps["classifierProvider"];
			activeHold?: EngineDeps["activeHold"];
			/** Override the report quiet window (default 5 ms). Incident tests use the production 180_000. */
			quietMs?: number;
		} = {},
	) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-engine-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		const store = o.store ?? memStore();
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		const priv = (name: string, body: string) => writeFileSync(`${conf}/${name}`, body, { mode: 0o600 });
		priv("decision-rights.md", "The Steward may merge green PRs. Everything else, ask.");
		if (o.steward) priv("steward-thread", o.steward);
		if (o.decisions) priv("decisions-thread", o.decisions);
		const fake = o.adapter ?? createFakeAdapter({ capabilities: o.capabilities });
		/** The relay's clock: a post counts as "busy" for 30 seconds after it, so a test that sends two wakes moves it on. */
		const clock = { t: Date.now() };
		const events: Logged[] = [];
		const deps: EngineDeps = {
			conf,
			lock: testRelayLock(store),
			alert: noAlert,
			store: o.wrap ? o.wrap(store) : store,
			dry: o.dry,
			compactAt: o.compactAt,
			housekeeping: o.housekeeping ?? false,
			gh: o.gh,
			ask: o.ask,
			...(o.classifierProvider ? { classifierProvider: o.classifierProvider } : {}),
			...(o.activeHold ? { activeHold: o.activeHold } : {}),
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: o.quietMs ?? 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => clock.t },
		};
		const engine = makeEngine(deps);
		engines.push(engine);
		const running = engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > end)
					throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
				await Bun.sleep(5);
			}
		};
		const quiet = (ms = 80) => Bun.sleep(ms);
		const held = (): HeldItem[] => store.wakes.held();
		return { fake, engine, events, conf, store, priv, until, quiet, held, running, clock };
	}

	const thread = (id: string, status: string, over: Partial<ThreadInput> = {}): ThreadInput => ({
		id,
		title: `Thread ${id}`,
		status,
		...over,
	});

	const stewardSigned: TurnItem = {
		type: "user_message",
		id: "s1",
		text: "Steward: build it",
		createdBy: "agent",
		creationSource: "mcp",
	};

	const question: WaitingItem = {
		type: "user_input_request",
		requestId: "req-1",
		label: "Pick",
		questions: [{ question: "Merge now?", options: [{ label: "Yes", description: "ship it" }, { label: "No" }] }],
	};

	// ---- a notification decision and its wake are one transaction -----------------------------------

	/**
	 * A store whose writes can be made to fail where a crash would land: after the decision has been written and before the wake's
	 * outbox (or held) row is. `fail.at` names the write that throws; every write is delegated otherwise.
	 */
	function flaky() {
		const fail = { at: undefined as undefined | "enqueue" | "held-push" | "hold-item" };
		const wrap = (s: Store): Store => ({
			...s,
			wakes: {
				...s.wakes,
				enqueue: (...a: Parameters<Store["wakes"]["enqueue"]>) => {
					if (fail.at === "enqueue") throw Error("the disk went away");
					return s.wakes.enqueue(...a);
				},
				hold: (...a: Parameters<Store["wakes"]["hold"]>) => {
					if (fail.at === "held-push") throw Error("the disk went away");
					return s.wakes.hold(...a);
				},
			},
			items: {
				...s.items,
				observe: (o) => {
					if (fail.at === "hold-item" && o.source === "held") throw Error("the disk went away");
					return s.items.observe(o);
				},
			},
		});
		return { fail, wrap };
	}

	/** The three "rights unchanged" pointer lines the daemon wrote before migration 9 stamped them, verbatim from git history. */
	const POINTER_545334A =
		"Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";

	const POINTER_V010 =
		"Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md in the config directory, and the rulings in force are listed in the hand-off (`bun src/brief.ts steward`).";

	const pointerAt = (at: string) =>
		`Decision rights and rulings unchanged since ${at} and still in force; your hand-off (steward-brief.md) has them.`;

	return { POINTER_545334A, POINTER_V010, dirs, engines, flaky, pointerAt, question, rig, stewardSigned, thread };
}
