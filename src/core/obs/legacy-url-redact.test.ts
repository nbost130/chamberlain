/**
 * M1: the legacy events/stdout boundary redacts URL-shaped text before the line is queued, written or printed.
 * Typed obs.db scrubbing does not protect this independent copy.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { everything } from "../../testing/obs.ts";
import { logFor, obsFor } from "../log.ts";
import { openStore } from "../store/sqlite-store.ts";
import { dbPath } from "../store/store.ts";
import { OBS_MIGRATIONS, obsPath } from "./db.ts";

const TOKEN = "ZQXLEGACYMARK9";
const PLAIN = `https://hooks.example.test/legacy/${TOKEN}`;
const ENCODED = `https%3A%2F%2Fhooks.example.test%2Flegacy%2F${TOKEN}`;
const LONG = `https://hooks.example.test/${"b".repeat(160)}${TOKEN}`;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.CHAMBERLAIN_VERBOSE;
});

const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-legacy-url-`);
	dirs.push(d);
	return d;
};

function assertNoToken(where: string, text: string) {
	expect(text.includes(TOKEN), `${where} must not hold ${TOKEN}`).toBe(false);
	for (let i = 0; i <= TOKEN.length - 8; i++) {
		const frag = TOKEN.slice(i, i + 8);
		expect(text.includes(frag), `${where} must not hold ${frag}`).toBe(false);
	}
}

function captureStd(run: () => void | Promise<void>) {
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
	return (async () => {
		try {
			await run();
		} finally {
			console.log = oLog;
			console.error = oErr;
			process.stdout.write = oOut;
			process.stderr.write = oEout;
		}
		return { out: out.join(""), err: err.join("") };
	})();
}

describe("legacy events/stdout redact URLs (M1)", () => {
	test("logFor deliver-error with plain, encoded and long URLs: events and verbose stdout hold no token", async () => {
		const root = scratch();
		const store = openStore(dbPath(`${root}/state`));
		process.env.CHAMBERLAIN_VERBOSE = "1";
		const { out, err } = await captureStd(async () => {
			const log = logFor(store, { src: "relay" });
			for (const url of [PLAIN, ENCODED, LONG]) {
				log("deliver-error", { deliveryId: "probe", attempt: 1, error: `failed ${url}` });
			}
			obsFor(store).flushMirror();
			await Promise.resolve();
			obsFor(store).flushMirror();
		});
		const events = JSON.stringify(store.events.query());
		expect(store.events.query().filter((e) => e.event === "deliver-error")).toHaveLength(3);
		for (const row of store.events.query().filter((e) => e.event === "deliver-error")) {
			expect(String(row.error)).toContain("<url>");
		}
		assertNoToken("events", events);
		assertNoToken("stdout", out);
		assertNoToken("stderr", err);
		assertNoToken("obs.db", everything(obsFor(store)));
		store.close();
	});

	test("when obs.db is unavailable the legacy mirror still redacts before events and stdout", async () => {
		const root = scratch();
		const state = `${root}/state`;
		mkdirSync(state, { recursive: true, mode: 0o700 });
		const path = obsPath(state);
		const db = new Database(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		db.query("INSERT INTO migrations VALUES (?, 'from the future', 'now')").run(
			(OBS_MIGRATIONS.at(-1)?.version ?? 0) + 9,
		);
		db.close();
		const store = openStore(dbPath(state));
		process.env.CHAMBERLAIN_VERBOSE = "1";
		const { out, err } = await captureStd(async () => {
			logFor(store)("deliver-error", { deliveryId: "probe", attempt: 1, error: `failed ${PLAIN}` });
			obsFor(store).flushMirror();
			await Promise.resolve();
			obsFor(store).flushMirror();
		});
		expect(obsFor(store).handle).toBeUndefined();
		const row = store.events.query().find((e) => e.event === "deliver-error");
		expect(row).toBeDefined();
		expect(String(row!.error)).toBe("failed <url>");
		assertNoToken("events (obs down)", JSON.stringify(store.events.query()));
		assertNoToken("stdout (obs down)", out);
		assertNoToken("stderr (obs down)", err);
		store.close();
	});
});
