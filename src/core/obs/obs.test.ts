import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { useCoreObsObsFixtures } from "../../testing/core-obs-obs-fixtures.ts";
import { dataOf, eventRows, everything, HOST, memObs, THREAD } from "../../testing/obs.ts";
import { memStore } from "../../testing/store.ts";
import { logFor, obsFor } from "../log.ts";
import { OBS_MIGRATIONS } from "./db.ts";
import { corrOf } from "./fields.ts";
import { makeLogger } from "./logger.ts";
import { Obs } from "./obs.ts";
import { hostName } from "./obs-spec.ts";

const { scratch } = useCoreObsObsFixtures();

describe("typed calls", () => {
	test("a row has every column the design names, and typed data", () => {
		const obs = memObs();
		const log = makeLogger(obs, { mod: "relay", thread: THREAD, corr: "0123456789ab" });
		log.info("wake.delivered", { http: 202, attempt: 1 });
		const [r] = eventRows(obs);
		expect(r).toMatchObject({
			level: "info",
			host: HOST,
			run: "aaaaaaaaaaaa",
			mod: "relay",
			event: "wake.delivered",
			corr: "0123456789ab",
			delivery: null,
			thread: THREAD,
			source_key: null,
		});
		expect(JSON.parse(r!.data)).toEqual({ http: 202, attempt: 1 });
		expect(new Date(r!.t).toISOString()).toBe(r!.t);
	});

	test("warn and error are stored at their level; debug only when asked for", () => {
		const obs = memObs();
		const log = makeLogger(obs, { mod: "relay" });
		log.warn("wake.stale", { age_ms: 5 });
		log.error("wake.dead-letter", { attempts: 3 });
		log.debug("wake.queued", { kind: "failed" });
		expect(eventRows(obs).map((r) => r.level)).toEqual(["warn", "error"]);
		expect(obs.levels).toMatchObject({ warn: 1, error: 1, debug: 0 });
		const loud = memObs({ debug: true });
		makeLogger(loud, { mod: "relay" }).debug("wake.queued", { kind: "failed" });
		expect(eventRows(loud).map((r) => r.level)).toEqual(["debug"]);
	});

	test("a delivery id is stored only as its digest, and an answer's wake joins its question", () => {
		const obs = memObs();
		const raw = `thread:abc:input:req-1:${"x".repeat(250)}`;
		makeLogger(obs, { mod: "relay", delivery: raw }).info("wake.delivered", { http: 202 });
		makeLogger(obs, { mod: "relay", delivery: "answer:item:Q-ab12cd34" }).info("wake.delivered", { http: 202 });
		const [a, b] = eventRows(obs);
		expect(a).toMatchObject({ delivery: corrOf(raw), corr: corrOf(raw) });
		expect(b).toMatchObject({ delivery: corrOf("answer:item:Q-ab12cd34"), corr: corrOf("item:Q-ab12cd34") });
		expect(everything(obs)).not.toContain("xxxx");
	});

	test("a thread that is not a UUID (a title, say) is dropped and counted", () => {
		const obs = memObs();
		makeLogger(obs, { mod: "relay", thread: "Deploy the billing fix" }).info("wake.delivered", { http: 202 });
		expect(eventRows(obs)[0]?.thread).toBeNull();
		expect(everything(obs)).not.toContain("billing");
		expect(obs.counters.rejected).toBe(1);
	});

	test("an unknown event is dropped and counted; an unknown field or a wrong value is dropped from its row and counted", () => {
		const obs = memObs();
		const log = makeLogger(obs, { mod: "relay" });
		log.info("wake.never-registered" as never, { http: 202 });
		expect(eventRows(obs)).toEqual([]);
		expect(obs.counters.rejected).toBe(1);
		log.info("wake.delivered", { http: 202, note: "Fix the login bug", attempt: "one" });
		expect(dataOf(obs, "wake.delivered")).toEqual([{ http: 202 }]);
		expect(obs.counters.rejected).toBe(3);
		expect(everything(obs)).not.toContain("login");
	});

	test("an undefined field is simply absent, not a rejection", () => {
		const obs = memObs();
		makeLogger(obs, { mod: "relay" }).info("wake.delivered", { http: 202, attempt: undefined });
		expect(obs.counters.rejected).toBe(0);
		expect(dataOf(obs, "wake.delivered")).toEqual([{ http: 202 }]);
	});

	test("a known set takes only the names it was given", () => {
		const obs = memObs();
		const log = makeLogger(obs, { mod: "relay" });
		log.info("fire", { server: "mac", kind: "failed" });
		expect(dataOf(obs, "fire")).toEqual([{ kind: "failed" }]);
		obs.allow("server", ["mac"]);
		log.info("fire", { server: "mac", kind: "failed" });
		expect(dataOf(obs, "fire")[1]).toEqual({ server: "mac", kind: "failed" });
	});

	test("child() adds to the binding", () => {
		const obs = memObs();
		const log = makeLogger(obs, { mod: "relay" }).child({ thread: THREAD });
		log.info("wake.delivered", { http: 202 });
		expect(eventRows(obs)[0]).toMatchObject({ mod: "relay", thread: THREAD });
	});
});

describe("a log call never throws and never waits", () => {
	test("a closed database, a throwing mirror and nonsense input all return quietly", () => {
		const complaints: string[] = [];
		const obs = memObs({
			complain: (m) => complaints.push(m),
			mirror: () => {
				throw Error("the old table is gone");
			},
		});
		const log = makeLogger(obs, { mod: "relay" });
		expect(() =>
			log("delivered", {
				deliveryId: 5 as never,
				error: {
					toString: () => {
						throw Error("boom");
					},
				},
			}),
		).not.toThrow();
		expect(() => log.info("wake.delivered", { http: Number.NaN, attempt: 1n as never })).not.toThrow();
		obs.close();
		expect(() => log.info("wake.delivered", { http: 202 })).not.toThrow();
		expect(() => log("delivered", { http: 202 })).not.toThrow();
		expect(complaints.length).toBeGreaterThan(0);
	});

	test("a held write lock does not block: the row waits in memory and lands on a later call", () => {
		const dir = scratch();
		const path = `${dir}/obs.db`;
		let now = 1_000_000;
		const complaints: string[] = [];
		const obs = memObs({ path, now: () => now, complain: (m) => complaints.push(m) });
		const log = makeLogger(obs, { mod: "relay" });
		log.info("wake.delivered", { http: 200 });
		const other = new Database(path);
		other.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		log.info("wake.delivered", { http: 201 });
		log.info("wake.delivered", { http: 202 });
		expect(performance.now() - started).toBeLessThan(250);
		expect(obs.counters.failed).toBeGreaterThan(0);
		expect(complaints).toHaveLength(1);
		other.exec("ROLLBACK");
		other.close();
		now += 1000;
		log.info("wake.delivered", { http: 203 });
		expect(new Set(dataOf(obs, "wake.delivered").map((d) => d.http))).toEqual(new Set([200, 201, 202, 203]));
		obs.close();
	});

	test("a buffer that fills drops the oldest and counts it", () => {
		const dir = scratch();
		const path = `${dir}/obs.db`;
		const obs = memObs({ path, complain: () => {} });
		const log = makeLogger(obs, { mod: "relay" });
		log.info("wake.delivered", { http: 200 });
		const other = new Database(path);
		other.exec("BEGIN IMMEDIATE");
		for (let i = 0; i < 600; i++) log.info("wake.delivered", { http: i });
		expect(obs.counters.dropped).toBe(100);
		other.exec("ROLLBACK");
		other.close();
		obs.close();
	});

	test("an obs.db that cannot be opened makes every call a no-op, and the old table is still written", () => {
		const dir = scratch();
		const path = `${dir}/obs.db`;
		const db = new Database(path);
		db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		db.query("INSERT INTO migrations VALUES (?, 'from the future', 'now')").run(
			(OBS_MIGRATIONS.at(-1)?.version ?? 0) + 5,
		);
		db.close();
		const complaints: string[] = [];
		const store = memStore();
		const obs = new Obs({
			path,
			host: HOST,
			complain: (m) => complaints.push(m),
			mirror: (lines) => store.events.tryAppendMany(lines),
		});
		const log = makeLogger(obs, {});
		expect(() => log("fire", { server: "mac", kind: "failed" })).not.toThrow();
		expect(obs.handle).toBeUndefined();
		expect(complaints.join(" ")).toContain("ObsTooNewError");
		obs.flushMirror();
		expect(store.events.query().map((e) => e.event)).toEqual(["fire"]);
		expect(obs.counters.dropped).toBe(1);
		store.close();
	});
});

describe("the file", () => {
	test("obs.db is private (0600), WAL, and carries its own migrations", () => {
		const dir = scratch();
		const path = `${dir}/obs.db`;
		const obs = memObs({ path });
		makeLogger(obs, { mod: "relay" }).info("wake.delivered", { http: 202 });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(obs.handle?.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		expect(obs.handle?.query("SELECT version FROM migrations").all()).toEqual(
			OBS_MIGRATIONS.map((m) => ({ version: m.version })),
		);
		obs.close();
	});

	test("it sits beside chamberlain.db and is never a table of it", () => {
		const dir = scratch();
		const store = memStore();
		expect(obsFor(store).handle).toBeDefined();
		const real = (require("../sqlite-store.ts") as typeof import("../sqlite-store.ts")).openStore(
			`${dir}/chamberlain.db`,
		);
		logFor(real).info("wake.delivered", { http: 202 });
		expect(statSync(`${dir}/obs.db`).isFile()).toBe(true);
		const ledger = new Database(`${dir}/chamberlain.db`, { readonly: true });
		const tables = (
			ledger.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
		).map((t) => t.name);
		expect(tables).not.toContain("obs_counter");
		ledger.close();
		real.close();
		store.close();
	});

	test("host is a lowercase label: the machine's name, cleaned", () => {
		expect(hostName({ CHAMBERLAIN_HOST: "Nathans-MacBook Air.local" })).toBe("nathans-macbook-air-local");
		expect(hostName({ CHAMBERLAIN_HOST: "" })).toMatch(/^[a-z0-9-]{1,32}$/);
	});
});

describe("the counters", () => {
	test("they are kept in obs.db, added to by every process, and read zero when nothing was caught", () => {
		const dir = scratch();
		const path = `${dir}/obs.db`;
		const a = memObs({ path });
		const b = memObs({ path });
		makeLogger(a, {}).info("nothing.registered" as never);
		makeLogger(b, {}).info("nothing.registered" as never);
		makeLogger(b, {}).info("nothing.registered" as never);
		b.flush();
		expect(a.totals()).toEqual({ rejected: 3, redacted: 0, failed: 0, dropped: 0 });
		a.close();
		b.close();
	});
});
