/** obs, continued: see obs.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { useCoreObsObsFixtures } from "../../testing/core-obs-obs-fixtures.ts";
import { dataOf, eventRows, everything, memObs, THREAD } from "../../testing/obs.ts";
import { memStore } from "../../testing/store.ts";
import { logFor, obsFor } from "../log.ts";
import { corrOf } from "./fields.ts";
import { makeLogger } from "./logger.ts";

const { scratch } = useCoreObsObsFixtures();

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

	test("CHAMBERLAIN_VERBOSE still prints the old line as JSON", async () => {
		const store = memStore();
		const lines: string[] = [];
		const was = console.log;
		process.env.CHAMBERLAIN_VERBOSE = "1";
		console.log = (s: string) => lines.push(s);
		try {
			logFor(store)("start", { dry: false });
			await Promise.resolve();
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
				{ ctx: { mod: "ledger" }, opts: { sourceKey: "decision:7", t: "2026-11-01T00:00:00.000Z" } },
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
