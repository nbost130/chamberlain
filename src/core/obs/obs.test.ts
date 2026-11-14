import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dataOf, eventRows, everything, HOST, memObs, THREAD } from "../../testing/obs.ts";
import { memStore } from "../../testing/store.ts";
import { logFor, obsFor } from "../log.ts";
import { OBS_MIGRATIONS } from "./db.ts";
import { corrOf } from "./fields.ts";
import { makeLogger } from "./logger.ts";
import { hostName, Obs } from "./obs.ts";

const dirs: string[] = [];
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-obs-`);
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
		log.info("wake.never-registered", { http: 202 });
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
			mirror: (line, key) => store.events.append(line, key),
		});
		const log = makeLogger(obs, {});
		expect(() => log("fire", { server: "mac", kind: "failed" })).not.toThrow();
		expect(obs.handle).toBeUndefined();
		expect(complaints.join(" ")).toContain("ObsTooNewError");
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
		makeLogger(a, {}).info("nothing.registered");
		makeLogger(b, {}).info("nothing.registered");
		makeLogger(b, {}).info("nothing.registered");
		b.flush();
		expect(a.totals()).toEqual({ rejected: 3, redacted: 0, failed: 0, dropped: 0 });
		a.close();
		b.close();
	});
});

describe("the old call, read through the registry", () => {
	test("what the registry names is stored typed, and what it does not name is left in the old table only", () => {
		const store = memStore();
		const obs = obsFor(store);
		obs.allow("server", ["mac"]);
		const raw = "thread:abc:input:req-1";
		const log = logFor(store);
		log("fire", {
			server: "mac",
			kind: "needs_input",
			threadId: THREAD,
			title: "Fix the login bug at /home/nbost/x",
			idle: true,
		});
		log("delivered", {
			deliveryId: raw,
			http: 202,
			attempt: 2,
			error: "connect ECONNREFUSED 10.0.0.1:9",
			queuedAt: "x",
		});
		const [fire, delivered] = eventRows(obs);
		expect(fire).toMatchObject({ event: "fire", mod: "fire", thread: THREAD });
		expect(JSON.parse(fire!.data)).toEqual({ server: "mac", kind: "needs_input", idle: true });
		expect(delivered).toMatchObject({
			event: "wake.delivered",
			delivery: corrOf(raw),
			corr: corrOf(raw),
			level: "info",
		});
		expect(JSON.parse(delivered!.data)).toEqual({ http: 202, attempt: 2 });
		expect(everything(obs)).not.toMatch(/login|\/home|ECONNREFUSED|10\.0\.0\.1|thread:abc/);
		// The old table keeps its line exactly as before.
		const old = store.events.query();
		expect(old.map((e) => e.event)).toEqual(["fire", "delivered"]);
		expect(old[0]).toMatchObject({ title: "Fix the login bug at /home/nbost/x", threadId: THREAD });
		store.close();
	});

	test("an event the registry does not know is counted and still reaches the old table", () => {
		const store = memStore();
		logFor(store)("some-new-event", { a: 1 });
		expect(obsFor(store).counters.rejected).toBe(1);
		expect(store.events.query().map((e) => e.event)).toEqual(["some-new-event"]);
		store.close();
	});

	test("an error is stored as its class", () => {
		const store = memStore();
		logFor(store)("tick-error", { error: "Error: read ECONNRESET at /srv/app/x.ts:1" });
		expect(dataOf(obsFor(store), "tick-error")).toEqual([{ err: "ECONNRESET" }]);
		expect(eventRows(obsFor(store))[0]?.level).toBe("error");
		store.close();
	});

	test("the base fields and the module of the page's logger", () => {
		const store = memStore();
		logFor(store, { src: "queue-web" })("web-start", { port: 31337, test: false, host: "127.0.0.1", title: "live" });
		expect(eventRows(obsFor(store))[0]).toMatchObject({ mod: "queue-web", event: "web-start" });
		expect(dataOf(obsFor(store), "web-start")).toEqual([{ port: 31337, test: false }]);
		expect(store.events.query()[0]).toMatchObject({ src: "queue-web", host: "127.0.0.1" });
		store.close();
	});

	test("CHAMBERLAIN_VERBOSE still prints the old line as JSON", () => {
		const store = memStore();
		const lines: string[] = [];
		const was = console.log;
		process.env.CHAMBERLAIN_VERBOSE = "1";
		console.log = (s: string) => lines.push(s);
		try {
			logFor(store)("start", { dry: false });
		} finally {
			console.log = was;
			delete process.env.CHAMBERLAIN_VERBOSE;
		}
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "start", dry: false });
		store.close();
	});
});

describe("log.change: one row per outage", () => {
	test("a typed change writes on a transition and counts what it suppressed", () => {
		const obs = memObs();
		obs.allow("server", ["mac"]);
		const log = makeLogger(obs, { mod: "watch" });
		log.change("server.mac", "down", { err: "ECONNREFUSED" });
		for (let i = 0; i < 99; i++) log.change("server.mac", "down", { err: "ECONNREFUSED" });
		log.change("server.mac", "up");
		log.change("server.mac", "up");
		expect(dataOf(obs, "server.state")).toEqual([
			{ name: "mac", state: "down", suppressed: 0, err: "ECONNREFUSED" },
			{ name: "mac", state: "up", suppressed: 99 },
		]);
		expect(eventRows(obs).map((r) => r.level)).toEqual(["warn", "info"]);
	});

	test("an unknown family or state is rejected, not thrown", () => {
		const obs = memObs();
		const log = makeLogger(obs, {});
		expect(() => log.change("nope.mac", "down")).not.toThrow();
		expect(() => log.change("server.mac", "sideways")).not.toThrow();
		expect(() => log.change("server", "down")).not.toThrow();
		expect(eventRows(obs)).toEqual([]);
		expect(obs.counters.rejected).toBe(3);
	});

	test("session-error, called 7,904 times for one dead server, is one row in each table; the connect that ends the outage says how many it suppressed", () => {
		const store = memStore();
		const obs = obsFor(store);
		obs.allow("server", ["mac"]);
		const log = logFor(store);
		for (let i = 0; i < 7904; i++)
			log("session-error", { server: "mac", error: "connect ECONNREFUSED 100.64.0.2:3773" });
		expect(eventRows(obs).map((r) => r.event)).toEqual(["server.state"]);
		expect(store.events.query().filter((e) => e.event === "session-error")).toHaveLength(1);
		log("connected", { server: "mac", resumeFrom: 12 });
		log("session-error", { server: "mac", error: "connect ECONNREFUSED" });
		expect(dataOf(obs, "server.state")).toEqual([
			{ name: "mac", state: "down", suppressed: 0, err: "ECONNREFUSED" },
			{ name: "mac", state: "up", suppressed: 7903 },
			{ name: "mac", state: "down", suppressed: 0, err: "ECONNREFUSED" },
		]);
		expect(eventRows(obs).map((r) => r.event)).toEqual(["server.state", "server.state", "connected", "server.state"]);
		store.close();
	});

	test("a connect with no failure before it writes its own row and no state row", () => {
		const store = memStore();
		const obs = obsFor(store);
		obs.allow("server", ["mac"]);
		logFor(store)("connected", { server: "mac" });
		expect(eventRows(obs).map((r) => r.event)).toEqual(["connected"]);
		store.close();
	});

	test("two servers have separate outages", () => {
		const store = memStore();
		const obs = obsFor(store);
		obs.allow("server", ["mac", "omar"]);
		const log = logFor(store);
		log("session-error", { server: "mac", error: "x" });
		log("session-error", { server: "omar", error: "x" });
		log("session-error", { server: "mac", error: "x" });
		expect(dataOf(obs, "server.state").map((d) => d.name)).toEqual(["mac", "omar"]);
		store.close();
	});
});

describe("source_key and the dual write", () => {
	test("a keyed row appears once in each table, however often it is emitted", () => {
		const store = memStore();
		const obs = obsFor(store);
		const call = () =>
			obs.record(
				"info",
				"decision.logged",
				{ cited: 2 },
				{ mod: "ledger" },
				{ sourceKey: "decision:7", t: "2026-11-01T00:00:00.000Z" },
			);
		expect(call()).toBe("stored");
		expect(call()).toBe("ignored");
		expect(eventRows(obs, "source_key = 'decision:7'")).toHaveLength(1);
		expect(store.events.query().filter((e) => e.event === "decision.logged")).toHaveLength(1);
		expect(eventRows(obs)[0]?.t).toBe("2026-11-01T00:00:00.000Z");
		store.close();
	});
});

describe("nothing here reads the developer's home", () => {
	test("the scratch state the preload set is where a store's telemetry goes", () => {
		const dir = scratch();
		writeFileSync(`${dir}/marker`, "x");
		const store = memStore();
		expect(obsFor(store).handle?.filename).toBe(":memory:");
		expect(process.env.HOME).not.toBe(process.env.REAL_HOME ?? "/nonexistent");
		expect(process.env.CHAMBERLAIN_STATE?.startsWith(process.env.TMPDIR ?? "/")).toBe(true);
		store.close();
	});
});
