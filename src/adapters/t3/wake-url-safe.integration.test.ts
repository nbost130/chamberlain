/**
 * M2 integration: real logFor, both SQLite files, flush, close inside stdout/stderr capture, then reopen
 * both DBs. Synthetic URL is the webhook target (or thrown/returned error text for relay-layer fixtures).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOutbox, type WakeResult, type WakeTransport } from "../../core/delivery/deliver.ts";
import { createRelay } from "../../core/delivery/relay.ts";
import { createStewardCheck } from "../../core/engine/engine-steward.ts";
import { logFor, obsFor } from "../../core/log.ts";
import { obsPath } from "../../core/obs/db.ts";
import { openStore } from "../../core/store/sqlite-store.ts";
import { dbPath } from "../../core/store/store.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { postWebhook, webhookWake } from "./wake.ts";

const TOKEN = "ZQXINTEGMARK91";
const URLS = {
	plain: `https://hooks.example.test/wake/${TOKEN}`,
	encoded: `https%3A%2F%2Fhooks.example.test%2Fwake%2F${TOKEN}`,
	long: `https://hooks.example.test/${"c".repeat(220)}${TOKEN}`,
} as const;
type Lane = "wake" | "compact";
type Shape = keyof typeof URLS;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.CHAMBERLAIN_VERBOSE;
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-url-integ-`);
	dirs.push(d);
	return d;
};

function dumpDb(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
		return JSON.stringify(tables.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name}"`).all() })));
	} finally {
		db.close();
	}
}

function assertNoToken(where: string, text: string) {
	expect(text.includes(TOKEN), `${where} must not hold ${TOKEN}`).toBe(false);
	for (let i = 0; i <= TOKEN.length - 8; i++)
		expect(text.includes(TOKEN.slice(i, i + 8)), `${where} must not hold fragment`).toBe(false);
}

async function captureStd<T>(run: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
	const out: string[] = [],
		err: string[] = [];
	const oLog = console.log,
		oErr = console.error,
		oOut = process.stdout.write.bind(process.stdout),
		oEout = process.stderr.write.bind(process.stderr);
	console.log = (...a: unknown[]) => {
		out.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		err.push(a.map(String).join(" "));
	};
	process.stdout.write = ((c: unknown) => {
		out.push(String(c));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((c: unknown) => {
		err.push(String(c));
		return true;
	}) as typeof process.stderr.write;
	try {
		return { value: await run(), out: out.join(""), err: err.join("") };
	} finally {
		console.log = oLog;
		console.error = oErr;
		process.stdout.write = oOut;
		process.stderr.write = oEout;
	}
}

function fetchFor(target: string, fail: "throw" | "http"): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		expect(String(input)).toBe(target);
		if (fail === "http") return new Response(null, { status: 503 });
		throw Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error(`getaddrinfo ${target}`), { code: "ENOTFOUND" }),
		});
	}) as unknown as typeof fetch;
}

function assertSinksAfterClose(state: string, out: string, err: string) {
	assertNoToken("stdout", out);
	assertNoToken("stderr", err);
	assertNoToken("chamberlain.db (reopened)", dumpDb(dbPath(state)));
	assertNoToken("obs.db (reopened)", dumpDb(obsPath(state)));
	const db = new Database(dbPath(state), { readonly: true });
	try {
		const rows = db.query("SELECT * FROM events").all() as Record<string, unknown>[];
		assertNoToken("events (reopened)", JSON.stringify(rows));
		expect(rows.some((r) => r.event === "deliver-error")).toBe(true);
	} finally {
		db.close();
	}
}

function world(state: string, wake: WakeTransport, compact?: WakeTransport) {
	const store = openStore(dbPath(state));
	const log = logFor(store, { src: "relay" });
	process.env.CHAMBERLAIN_VERBOSE = "1";
	return {
		store,
		log,
		relay: createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log,
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake,
			...(compact ? { compact } : {}),
		}),
	};
}

const idle: WakeTransport = { ready: () => true, send: async () => ({ ok: true, status: 202 }) };

async function compactVia(log: ReturnType<typeof logFor>, relay: ReturnType<typeof createRelay>) {
	let production: WakeResult | undefined;
	await createStewardCheck({
		privateFile: (n) => (n === "steward-thread" ? "th-steward" : undefined),
		exclude: new Set(),
		probe: () => ({ readable: true, contextTokens: 99_999 }),
		rightsSent: { get: () => undefined, set: () => {}, epoch: () => 0 },
		compactReady: () => true,
		compact: async (id) => {
			production = await relay.compact(id);
			return production;
		},
		log,
		alarm: () => {},
		raiseAlarm: () => {},
		dry: false,
		compactAt: 100,
		onDecisionsThread: () => {},
	}).check();
	return production;
}

/** Real postWebhook / webhookWake / relay.compact — assert production return values only. */
async function runRealPostWebhook(lane: Lane, fail: "throw" | "http", target: string) {
	const state = `${scratch()}/state`;
	const transport = webhookWake(() => target, fetchFor(target, fail));
	const { store, log, relay } = world(
		state,
		lane === "wake" ? transport : idle,
		lane === "compact" ? transport : undefined,
	);
	const { value, out, err } = await captureStd(async () => {
		let production: WakeResult | undefined;
		if (lane === "wake") {
			production = await postWebhook(target, "direct", "m", fetchFor(target, fail));
			createOutbox({ store, log: () => {} }).deliver("m", `w-${fail}`);
			await relay.pass();
		} else production = await compactVia(log, relay);
		obsFor(store).flushMirror();
		await Promise.resolve();
		obsFor(store).flushMirror();
		store.close();
		return production;
	});
	expect(value).toBeDefined();
	assertNoToken("production WakeResult", JSON.stringify(value));
	expect(value).toEqual(fail === "http" ? { ok: false, status: 503 } : { ok: false, error: "network:ENOTFOUND" });
	if (lane === "wake") {
		const reopen = openStore(dbPath(state));
		expect(reopen.wakes.find(`w-${fail}`)).toMatchObject({ status: "dead_letter", attempts: 1 });
		reopen.close();
	}
	assertSinksAfterClose(state, out, err);
}

/** Relay-layer fixtures: fabricated throw / returned URL error (postWebhook never returns URL text). */
async function runRelayLayer(lane: Lane, fail: "throw" | "returned", target: string) {
	const state = `${scratch()}/state`;
	const transport: WakeTransport =
		fail === "throw"
			? {
					ready: () => true,
					send: async () => {
						throw new Error(`POST ${target} failed`);
					},
				}
			: { ready: () => true, send: async () => ({ ok: false, error: `refused ${target}` }) };
	const { store, log, relay } = world(
		state,
		lane === "wake" ? transport : idle,
		lane === "compact" ? transport : undefined,
	);
	const { value, out, err } = await captureStd(async () => {
		let production: WakeResult | undefined;
		if (lane === "wake") {
			createOutbox({ store, log: () => {} }).deliver("m", `w-${fail}`);
			await relay.pass(); // no WakeResult: assert persisted/logged outcomes after reopen
		} else production = await compactVia(log, relay);
		obsFor(store).flushMirror();
		await Promise.resolve();
		obsFor(store).flushMirror();
		store.close();
		return production;
	});
	if (lane === "compact" && fail === "returned") {
		// relay.compact returns the sanitized WakeResult for a returned error.
		expect(value).toBeDefined();
		assertNoToken("production WakeResult (relay.compact)", JSON.stringify(value));
		expect(value).toMatchObject({ ok: false });
		expect(String(value!.error)).toContain("<url>");
	} else {
		// wake: relay.pass returns no WakeResult. compact/throw: relay.compact rejects; sendCompact logs.
		expect(value).toBeUndefined();
		const reopen = openStore(dbPath(state));
		if (lane === "wake") expect(reopen.wakes.find(`w-${fail}`)).toMatchObject({ status: "dead_letter", attempts: 1 });
		const errRows = reopen.events.query().filter((e) => e.event === "deliver-error");
		expect(errRows.length).toBeGreaterThan(0);
		expect(String(errRows[0]!.error)).toContain("<url>");
		assertNoToken("persisted deliver-error", JSON.stringify(errRows));
		reopen.close();
	}
	assertSinksAfterClose(state, out, err);
}

describe("PR 0 integration: real postWebhook / webhookWake", () => {
	test("the long URL exceeds 250 characters", () => expect(URLS.long.length).toBeGreaterThan(250));
	for (const shape of Object.keys(URLS) as Shape[])
		for (const lane of ["wake", "compact"] as const)
			for (const fail of ["throw", "http"] as const)
				test(`${lane}/postWebhook-${fail}/${shape}`, async () => runRealPostWebhook(lane, fail, URLS[shape]));
});

describe("PR 0 integration: relay-layer fixtures (fabricated throw / returned URL error)", () => {
	for (const shape of Object.keys(URLS) as Shape[])
		for (const lane of ["wake", "compact"] as const)
			for (const fail of ["throw", "returned"] as const)
				test(`relay-layer ${lane}/${fail}/${shape}`, async () => runRelayLayer(lane, fail, URLS[shape]));
});

describe("PR 0 integration: legacy logger boundary (proves M1 from this suite)", () => {
	test("logFor deliver-error with target URL: clean after close+reopen", async () => {
		const target = URLS.long;
		expect(target.length).toBeGreaterThan(250);
		const state = `${scratch()}/state`;
		const store = openStore(dbPath(state));
		process.env.CHAMBERLAIN_VERBOSE = "1";
		const { out, err } = await captureStd(async () => {
			logFor(store, { src: "relay" })("deliver-error", { deliveryId: "probe", attempt: 1, error: `failed ${target}` });
			obsFor(store).flushMirror();
			await Promise.resolve();
			obsFor(store).flushMirror();
			store.close();
		});
		const reopen = openStore(dbPath(state));
		expect(String(reopen.events.query().find((e) => e.event === "deliver-error")!.error)).toBe("failed <url>");
		assertNoToken("events", JSON.stringify(reopen.events.query()));
		reopen.close();
		assertSinksAfterClose(state, out, err);
	});
});
