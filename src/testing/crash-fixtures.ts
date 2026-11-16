import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { askQuestion, type Question } from "../core/items/questions.ts";
import { ensureToken } from "../core/ops/capability.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import { dbPath, type Store } from "../core/store/store.ts";

export const SRC = new URL("..", import.meta.url).pathname;
export const TIMEOUT = 30_000;

let hook: ReturnType<typeof Bun.serve>;
export let accepted: { deliveryId: string; message: string }[] = [];
/** Optional probe invoked at the moment the fixture webhook receives a POST (C4 ordering). */
let wakeReceiptProbe: ((body: { deliveryId: string; message: string }) => void) | undefined;
export const setWakeReceiptProbe = (fn: typeof wakeReceiptProbe) => {
	wakeReceiptProbe = fn;
};

const dirs: string[] = [];
const procs: { kill: (s?: number) => void }[] = [];
const stores: Store[] = [];

const item = (id: string): Question => ({
	id,
	kind: "product",
	title: "Lead the onboarding with a photo?",
	context: "Two layouts tested.",
	options: [{ label: "Photo first" }, { label: "Text first" }],
	recommended: 0,
	proposedRuling: "Onboarding leads with a photo",
	thread: "Mobile app",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-09T10:00:00.000Z",
});

export const secret = (p: string, body: string) => {
	writeFileSync(p, body, { mode: 0o600 });
	chmodSync(p, 0o600);
};
async function freePort() {
	const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const p = s.port;
	s.stop(true);
	return p!;
}

/** A scratch HOME with a config dir and a state, the webhook as wake-url, and one asked question in the database. */
export async function world(id: string) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-crash-`);
	dirs.push(root);
	const conf = `${root}/conf`,
		state = `${root}/state`;
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	mkdirSync(state, { recursive: true });
	secret(`${conf}/wake-url`, `http://127.0.0.1:${hook.port}/wake`);
	// Seedable Steward generation (migration 15): without a thread id, recover cannot seed gen 1 and land() leaves
	// delivered Steward rows unledgered, so the next start would adopt and re-transfer them.
	secret(`${conf}/steward-thread`, "crash-steward-thread");
	// Idle T3 projection for that thread so the hold gate is idle (a missing DB is "unknown" and holds forever).
	const t3db = `${root}/t3-state.sqlite`;
	{
		const db = new Database(t3db);
		db.exec(`
			CREATE TABLE orchestration_v2_projection_runs (
				thread_id TEXT, ordinal INT, status TEXT, requested_at TEXT, payload_json TEXT
			);
			CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, payload_json TEXT);
			CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, type TEXT, updated_at TEXT);
			CREATE TABLE orchestration_v2_projection_runtime_requests (
				thread_id TEXT, created_at TEXT, resolved_at TEXT
			);
		`);
		db.close();
	}
	// The daemon's one server is a port nothing listens on: it starts, recovers, and retries its socket quietly.
	secret(
		`${conf}/servers.json`,
		JSON.stringify({
			servers: [{ name: "test", origin: "http://127.0.0.1:9", tokenFile: "read-token", mayBeOffline: true }],
		}),
	);
	secret(`${conf}/read-token`, "not-a-token");
	const port = await freePort();
	secret(`${conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port }));
	// The page's capability token, made before the page starts (it would make one itself): every request to the page must hold it.
	const key = ensureToken(conf);
	// The test's own connection: the same file the children use, read and written alongside them (WAL).
	const store = openStore(dbPath(state));
	stores.push(store);
	askQuestion(store, item(id));
	const env = {
		...process.env,
		HOME: root,
		CHAMBERLAIN_CONF: conf,
		CHAMBERLAIN_STATE: state,
		CHAMBERLAIN_T3_STATE_DB: t3db,
		CHAMBERLAIN_ALERT_CMD: "/bin/true",
		CHAMBERLAIN_DRY: "0",
		CHAMBERLAIN_VERBOSE: "",
	};
	const events = () =>
		store.events.query({ events: ["startup-recovered", "alarm"] }) as { event: string; src?: string }[];
	const spawn = (args: string[], crashAt?: string, extra: Record<string, string> = {}) => {
		const p = Bun.spawn(["bun", ...args], {
			env: { ...env, ...extra, ...(crashAt ? { CHAMBERLAIN_CRASH_AT: crashAt } : {}) },
			stdout: "ignore",
			stderr: "pipe",
		});
		procs.push(p);
		return p;
	};
	const until = async (what: string, ok: () => boolean, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!ok()) {
			if (Date.now() > end) throw Error(`timed out waiting for ${what}`);
			await Bun.sleep(25);
		}
	};
	return { root, conf, state, port, key, env, store, events, spawn, until };
}
export type World = Awaited<ReturnType<typeof world>>;

/** The process must have died by its own SIGKILL at the named step, not finished. */
export async function diedAt(p: ReturnType<World["spawn"]>, step: string) {
	await p.exited;
	const err = await new Response(p.stderr).text();
	expect({ step, signal: p.signalCode, err: err.slice(0, 400) }).toEqual({ step, signal: "SIGKILL", err: "" });
}

/** Exactly `n` POSTs, all of this item's one wake, every one under the same delivery id with the same text, ending with that id. */
export function wakes(id: string, deliveryId: string, n = 1) {
	const mine = accepted.filter((a) => a.deliveryId === deliveryId);
	expect(accepted.length).toBe(mine.length);
	expect(mine).toHaveLength(n);
	for (const a of mine) expect(a.message).toContain(id);
	for (const a of mine) expect(a.message.split("\n").at(-1)).toContain(`delivery id: ${deliveryId}`);
	expect(new Set(mine.map((a) => a.message)).size).toBeLessThanOrEqual(1);
}

/** Rows the raw database holds, read through a separate connection to the file (no Store): what a crash left on disk. */
export const rows = (w: World, sql: string) => {
	const db = new Database(dbPath(w.state), { readonly: true });
	try {
		return db.query(sql).all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
};
export const outbox = (w: World) => rows(w, "SELECT delivery_id, status, attempts FROM outbox ORDER BY id");

export const daemonArgs = [`${SRC}daemon.ts`];
/** A real daemon (the relay) on the world, run until its startup pass is done and `until` holds, then stopped. */
export async function daemon(w: World, until: () => boolean = () => true, extra: Record<string, string> = {}) {
	const before = w.events().filter((e) => e.event === "startup-recovered").length;
	const p = w.spawn(daemonArgs, undefined, extra);
	await w.until(
		"the relay's first pass",
		() => w.events().filter((e) => e.event === "startup-recovered").length > before,
	);
	await w.until("the daemon's work", until);
	await Bun.sleep(200);
	p.kill();
	await p.exited;
}

/** Registers this file's hooks: a local webhook for the run, and the scratch directories, processes and stores each test left. */
export function registerCrashHooks() {
	beforeAll(() => {
		hook = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (r) => {
				const body = (await r.json()) as { deliveryId: string; message: string };
				try {
					wakeReceiptProbe?.(body);
				} catch {
					/* probe must not break delivery */
				}
				accepted.push(body);
				return new Response(null, { status: 202 });
			},
		});
	});
	afterAll(() => hook.stop(true));
	afterEach(() => {
		for (const p of procs.splice(0)) {
			try {
				p.kill(9);
			} catch {
				/* gone */
			}
		}
		for (const s of stores.splice(0)) {
			try {
				s.close();
			} catch {
				/* closed */
			}
		}
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		accepted = [];
		wakeReceiptProbe = undefined;
	});
}
