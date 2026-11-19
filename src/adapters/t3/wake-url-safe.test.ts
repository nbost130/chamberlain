/**
 * PR 0: a webhook URL is a credential. Transport errors must never carry exception text (or any URL-shaped run) into
 * WakeResult, the log, the events table, obs.db, or verbose stdout. Sol B4 / design P1–P7.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createOutbox } from "../../core/delivery/deliver.ts";
import { createRelay } from "../../core/delivery/relay.ts";
import { createStewardCheck } from "../../core/engine/engine-steward.ts";
import { logFor, obsFor } from "../../core/log.ts";
import { obsPath } from "../../core/obs/db.ts";
import { openStore } from "../../core/store/sqlite-store.ts";
import { dbPath } from "../../core/store/store.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { everything } from "../../testing/obs.ts";
import { postWebhook } from "./wake.ts";

/** Synthetic only: never a real webhook host. The token is the leak probe. */
const TOKEN = "ZQXURLSENTINEL9";
const SENTINEL = `https://hooks.example.test/wake/${TOKEN}`;
const LONG_PAD = "a".repeat(160);
const LONG_SENTINEL = `https://hooks.example.test/${LONG_PAD}${TOKEN}`;
const ENCODED = `https%3A%2F%2Fhooks.example.test%2Fwake%2F${TOKEN}`;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.CHAMBERLAIN_VERBOSE;
});

const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-url-safe-`);
	dirs.push(d);
	return d;
};

/** Every cell of every table in a SQLite file, as one string. */
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
	expect(text.includes(TOKEN), `${where} must not hold the sentinel token`).toBe(false);
	// An 8-character fragment of the token must not survive truncation-before-redaction.
	for (let i = 0; i <= TOKEN.length - 8; i++) {
		const frag = TOKEN.slice(i, i + 8);
		expect(text.includes(frag), `${where} must not hold fragment ${frag}`).toBe(false);
	}
}

describe("PR 0: URL-safe transport errors", () => {
	test("P1: fetch Error with sentinel URL becomes a fixed class; WakeResult holds no sentinel", async () => {
		const res = await postWebhook("http://h/x", "id", "m", (async () => {
			throw new Error(`fetch failed: ${SENTINEL}`);
		}) as unknown as typeof fetch);
		expect(res.ok).toBe(false);
		expect(res.error).toBe("unknown");
		assertNoToken("WakeResult", JSON.stringify(res));
	});

	test("P2: a URL longer than 200 chars with the token past char 150 is redacted before truncation", async () => {
		expect(LONG_SENTINEL.length).toBeGreaterThan(200);
		expect(LONG_SENTINEL.indexOf(TOKEN)).toBeGreaterThan(150);
		const root = scratch();
		const store = openStore(dbPath(`${root}/state`));
		const log = logFor(store, { src: "relay" });
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log,
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake: {
				ready: () => true,
				send: async () => {
					throw new Error(`desk transport failed at ${LONG_SENTINEL}`);
				},
			},
		});
		createOutbox({ store, log: () => {} }).deliver("m", "w-long");
		const out: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => {
			out.push(a.map(String).join(" "));
		};
		process.env.CHAMBERLAIN_VERBOSE = "1";
		try {
			await relay.pass();
			obsFor(store).flushMirror();
		} finally {
			console.log = orig;
		}
		const events = store.events.query();
		const line = events.find((e) => e.event === "deliver-error");
		expect(line).toBeDefined();
		const logged = JSON.stringify(line);
		expect(logged.length).toBeLessThan(LONG_SENTINEL.length);
		assertNoToken("deliver-error event", logged);
		assertNoToken("chamberlain.db", dumpDb(dbPath(`${root}/state`)));
		assertNoToken("obs.db", everything(obsFor(store)));
		assertNoToken("verbose stdout", out.join("\n"));
		store.close();
	});

	test("P3: undici-style TypeError('fetch failed') with URL on cause is sanitized", async () => {
		const cause = Object.assign(new Error(`connect ${SENTINEL}`), { code: "ECONNREFUSED" });
		const res = await postWebhook("http://h/x", "id", "m", (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause });
		}) as unknown as typeof fetch);
		expect(res).toEqual({ ok: false, error: "network:ECONNREFUSED" });
		assertNoToken("WakeResult", JSON.stringify(res));
	});

	test("P4: compaction failures (throw, HTTP refusal, returned URL error) log deliver-error and never delivered", async () => {
		const base = {
			privateFile: (n: string) => (n === "steward-thread" ? "th-steward" : undefined),
			exclude: new Set<string>(),
			probe: () => ({ readable: true, contextTokens: 9_999 }),
			rightsSent: { get: () => undefined, set: () => {}, epoch: () => 0 },
			compactReady: () => true,
			alarm: () => {},
			raiseAlarm: () => {},
			dry: false,
			compactAt: 100,
			onDecisionsThread: () => {},
		};
		const run = async (compact: () => Promise<{ ok: boolean; status?: number; error?: string }>) => {
			const calls: [string, ...unknown[]][] = [];
			await createStewardCheck({
				...base,
				compactState: { get: () => undefined, set: () => {} },
				compact: async () => compact(),
				log: (event, data) => calls.push(["log", event, data]),
			}).check();
			return calls;
		};

		const thrown = await run(async () => {
			throw new Error(`compact POST failed: ${SENTINEL}`);
		});
		expect(thrown.filter((c) => c[1] === "delivered")).toEqual([]);
		const thrownErr = thrown.find((c) => c[1] === "deliver-error");
		expect(thrownErr).toBeDefined();
		assertNoToken("P4 throw", JSON.stringify(thrownErr));
		expect(JSON.stringify(thrownErr)).toContain("<url>");

		const http = await run(async () => ({ ok: false, status: 503 }));
		expect(http.filter((c) => c[1] === "delivered")).toEqual([]);
		expect(http.find((c) => c[1] === "deliver-error")?.[2]).toMatchObject({ http: 503, attempt: 1 });

		const returned = await run(async () => ({
			ok: false,
			error: `webhook refused at ${SENTINEL}`,
		}));
		expect(returned.filter((c) => c[1] === "delivered")).toEqual([]);
		const returnedErr = returned.find((c) => c[1] === "deliver-error");
		expect(returnedErr?.[2]).toMatchObject({ error: "webhook refused at <url>", attempt: 1 });
		assertNoToken("P4 returned WakeResult.error", JSON.stringify(returned));
	});

	test("P4b: a returned WakeResult.error with a sentinel is redacted by the relay before logging", async () => {
		const root = scratch();
		const store = openStore(dbPath(`${root}/state`));
		const events: { event: string; data?: Record<string, unknown> }[] = [];
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake: {
				ready: () => true,
				send: async () => ({ ok: false, error: `returned ${SENTINEL}` }),
			},
		});
		createOutbox({ store, log: () => {} }).deliver("m", "w-returned");
		await relay.pass();
		const err = events.find((e) => e.event === "deliver-error");
		expect(err?.data?.error).toBe("returned <url>");
		assertNoToken("returned WakeResult.error", JSON.stringify(events));
		store.close();
	});

	test("P5: a non-t3 transport that throws raw URL text is redacted by the relay layer", async () => {
		const root = scratch();
		const store = openStore(dbPath(`${root}/state`));
		const events: { event: string; data?: Record<string, unknown> }[] = [];
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake: {
				ready: () => true,
				send: async () => {
					throw new Error(`other adapter: ${SENTINEL} and also ${ENCODED}`);
				},
			},
		});
		createOutbox({ store, log: () => {} }).deliver("m", "w-other");
		await relay.pass();
		const err = events.find((e) => e.event === "deliver-error");
		expect(err?.data?.error).toBe("other adapter: <url> and also <url>");
		assertNoToken("relay events", JSON.stringify(events));
		store.close();
	});

	test("P6+P7: verbose stdout and both databases hold zero sentinel hits after a flush", async () => {
		const root = scratch();
		const store = openStore(dbPath(`${root}/state`));
		const log = logFor(store, { src: "relay" });
		const out: string[] = [];
		const err: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		console.log = (...a: unknown[]) => {
			out.push(a.map(String).join(" "));
		};
		console.error = (...a: unknown[]) => {
			err.push(a.map(String).join(" "));
		};
		process.env.CHAMBERLAIN_VERBOSE = "1";
		const relay = createRelay({
			store,
			lock: testRelayLock(store),
			gate: () => "idle",
			log,
			alarm: () => {},
			retryAfterMs: () => 0,
			maxAttempts: 1,
			wake: {
				ready: () => true,
				send: async (_id, _m) =>
					postWebhook(SENTINEL, _id, _m, (async () => {
						throw Object.assign(new TypeError("fetch failed"), {
							cause: Object.assign(new Error(`getaddrinfo ${SENTINEL}`), { code: "ENOTFOUND" }),
						});
					}) as unknown as typeof fetch),
			},
		});
		createOutbox({ store, log: () => {} }).deliver("m", "w-verbose");
		try {
			await relay.pass();
			obsFor(store).flushMirror();
			await Bun.sleep(5);
			obsFor(store).flushMirror();
		} finally {
			console.log = origLog;
			console.error = origErr;
		}
		assertNoToken("verbose stdout", out.join("\n"));
		assertNoToken("stderr", err.join("\n"));
		assertNoToken("chamberlain.db", dumpDb(dbPath(`${root}/state`)));
		assertNoToken("obs.db", dumpDb(obsPath(`${root}/state`)));
		assertNoToken("obs everything()", everything(obsFor(store)));
		const row = store.events.query().find((e) => e.event === "deliver-error");
		expect(row).toBeDefined();
		expect(String((row as { error?: string }).error ?? "")).toBe("network:ENOTFOUND");
		store.close();
	});
});
