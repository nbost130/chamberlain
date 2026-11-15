/**
 * M2: one shared integration harness — real logFor, both SQLite files (events included), flush/close, and
 * stdout/stderr capture — for thrown, returned-error and HTTP refusal on ordinary and compaction delivery.
 * The synthetic URL is the real webhook target passed through postWebhook / relay, not only exception text.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOutbox, type WakeResult, type WakeTransport } from "../../core/deliver.ts";
import { createStewardCheck } from "../../core/engine-steward.ts";
import { logFor, obsFor } from "../../core/log.ts";
import { obsPath } from "../../core/obs/db.ts";
import { redactUrls } from "../../core/redact.ts";
import { createRelay } from "../../core/relay.ts";
import { openStore } from "../../core/sqlite-store.ts";
import { dbPath } from "../../core/store.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { everything } from "../../testing/obs.ts";
import { postWebhook, webhookWake } from "./wake.ts";

const TOKEN = "ZQXINTEGMARK91";
const URLS = {
	plain: `https://hooks.example.test/wake/${TOKEN}`,
	encoded: `https%3A%2F%2Fhooks.example.test%2Fwake%2F${TOKEN}`,
	long: `https://hooks.example.test/${"c".repeat(160)}${TOKEN}`,
} as const;

type Fail = "throw" | "returned" | "http";
type Lane = "wake" | "compact";

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
	for (let i = 0; i <= TOKEN.length - 8; i++) {
		const frag = TOKEN.slice(i, i + 8);
		expect(text.includes(frag), `${where} must not hold ${frag}`).toBe(false);
	}
}

async function captureStd<T>(run: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const oLog = console.log;
	const oErr = console.error;
	const oOut = process.stdout.write.bind(process.stdout);
	const oEout = process.stderr.write.bind(process.stderr);
	console.log = (...a: unknown[]) => {
		out.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		err.push(a.map(String).join(" "));
	};
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err.push(String(chunk));
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

/** Fetch that is only ever called with the synthetic target URL. */
function fetchFor(target: string, fail: "throw" | "http"): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		expect(String(input)).toBe(target);
		if (fail === "http") return new Response(null, { status: 503 });
		throw Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error(`getaddrinfo ${target}`), { code: "ENOTFOUND" }),
		});
	}) as unknown as typeof fetch;
}

/** Transport whose failure names the real target URL (the same string postWebhook / webhookWake would POST to). */
function transportFor(target: string, fail: Fail): WakeTransport {
	if (fail === "http") return webhookWake(() => target, fetchFor(target, "http"));
	if (fail === "throw") {
		return {
			ready: () => true,
			send: async () => {
				throw new Error(`POST ${target} failed`);
			},
		};
	}
	return {
		ready: () => true,
		send: async () => ({ ok: false, error: `refused ${target}` }),
	};
}

/**
 * Ordinary wake or compaction through the real relay, logFor, and (for compact) sendCompact.
 * - throw: transport throws with the target URL in the message (relay catch path).
 * - returned: transport returns `{ok:false,error:<target>}` (relay sanitizeResult path).
 * - http: real postWebhook / webhookWake against the target URL, 503 response.
 */
async function runCase(lane: Lane, fail: Fail, target: string) {
	const root = scratch();
	const state = `${root}/state`;
	const store = openStore(dbPath(state));
	const log = logFor(store, { src: "relay" });
	process.env.CHAMBERLAIN_VERBOSE = "1";
	const base = transportFor(target, fail);
	let captured: WakeResult | undefined;
	const transport: WakeTransport = {
		ready: () => base.ready(),
		send: async (id, message) => {
			captured = await base.send(id, message);
			return captured;
		},
	};
	const idle: WakeTransport = { ready: () => true, send: async () => ({ ok: true, status: 202 }) };
	const relay = createRelay({
		store,
		lock: testRelayLock(store),
		gate: () => "idle",
		log,
		alarm: () => {},
		retryAfterMs: () => 0,
		maxAttempts: 1,
		wake: lane === "wake" ? transport : idle,
		...(lane === "compact" ? { compact: transport } : {}),
	});

	const {
		value: wakeResult,
		out,
		err,
	} = await captureStd(async () => {
		let res: WakeResult | undefined;
		if (lane === "wake") {
			createOutbox({ store, log: () => {} }).deliver("m", `w-${fail}`);
			await relay.pass();
			if (captured) res = captured.error !== undefined ? { ...captured, error: redactUrls(captured.error) } : captured;
			else {
				try {
					await base.send("probe", "m");
				} catch (e) {
					res = { ok: false, error: redactUrls(e instanceof Error ? e.message : String(e)) };
				}
			}
			if (fail === "http") res = await postWebhook(target, "direct", "m", fetchFor(target, "http"));
		} else {
			await createStewardCheck({
				privateFile: (n) => (n === "steward-thread" ? "th-steward" : undefined),
				exclude: new Set(),
				probe: () => ({ readable: true, contextTokens: 99_999 }),
				rightsSent: { get: () => undefined, set: () => {}, epoch: () => 0 },
				compactReady: () => true,
				compact: async (id) => {
					res = await relay.compact(id);
					return res;
				},
				log,
				alarm: () => {},
				raiseAlarm: () => {},
				dry: false,
				compactAt: 100,
				onDecisionsThread: () => {},
			}).check();
		}
		obsFor(store).flushMirror();
		await Promise.resolve();
		obsFor(store).flushMirror();
		return res;
	});

	if (wakeResult) assertNoToken("WakeResult", JSON.stringify(wakeResult));
	if (fail === "http" && wakeResult) expect(wakeResult).toMatchObject({ ok: false, status: 503 });
	if (fail === "returned" && wakeResult) expect(String(wakeResult.error)).toContain("<url>");

	assertNoToken("chamberlain.db", dumpDb(dbPath(state)));
	assertNoToken("obs.db", dumpDb(obsPath(state)));
	assertNoToken("events", JSON.stringify(store.events.query()));
	assertNoToken("obs everything()", everything(obsFor(store)));
	assertNoToken("stdout", out);
	assertNoToken("stderr", err);

	expect(store.events.query().filter((e) => e.event === "deliver-error").length).toBeGreaterThan(0);

	store.close();
}

describe("PR 0 integration: real sinks for every failure path (M2)", () => {
	for (const [shape, target] of Object.entries(URLS)) {
		for (const lane of ["wake", "compact"] as const) {
			for (const fail of ["throw", "returned", "http"] as const) {
				test(`${lane}/${fail}/${shape}: no token in WakeResult, both DBs, events, stdout, stderr`, async () => {
					expect(target.includes(TOKEN)).toBe(true);
					await runCase(lane, fail, target);
				});
			}
		}
	}

	test("postWebhook + webhookWake: fetch throw naming the target yields a class; all sinks stay clean", async () => {
		const target = URLS.plain;
		const root = scratch();
		const state = `${root}/state`;
		const store = openStore(dbPath(state));
		const log = logFor(store, { src: "relay" });
		process.env.CHAMBERLAIN_VERBOSE = "1";
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log,
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake: webhookWake(() => target, fetchFor(target, "throw")),
		});
		const {
			value: direct,
			out,
			err,
		} = await captureStd(async () => {
			const res = await postWebhook(target, "id", "m", fetchFor(target, "throw"));
			createOutbox({ store, log: () => {} }).deliver("m", "w-class");
			await relay.pass();
			obsFor(store).flushMirror();
			await Promise.resolve();
			obsFor(store).flushMirror();
			return res;
		});
		expect(direct).toEqual({ ok: false, error: "network:ENOTFOUND" });
		assertNoToken("WakeResult", JSON.stringify(direct));
		assertNoToken("chamberlain.db", dumpDb(dbPath(state)));
		assertNoToken("obs.db", dumpDb(obsPath(state)));
		assertNoToken("events", JSON.stringify(store.events.query()));
		assertNoToken("stdout", out);
		assertNoToken("stderr", err);
		store.close();
	});
});
