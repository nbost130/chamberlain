/**
 * The redaction guarantee, end to end (docs/OBSERVABILITY.md section 3): feed every event of the registry secret-shaped values, a webhook URL, a path, a title,
 * a prompt and an error with its message, through the typed API and through the old call, and nothing of it is in `obs.db`: not in a row, not in a counter, and not in
 * a byte of the file or its write-ahead log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { eventRows, everything, memObs } from "../../testing/obs.ts";
import { MARK, POISON, VECTORS } from "../../testing/secrets.ts";
import { makeLogger } from "./logger.ts";
import type { Obs } from "./obs.ts";
import { EVENTS, type EventSpec } from "./registry.ts";
import { RULES } from "./scrub.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const JUNK = [
	"title",
	"note",
	"path",
	"url",
	"message",
	"body",
	"prompt",
	"token",
	"apiKey",
	"password",
	"error",
	"reason",
	"why",
	"text",
];
const CONTEXT = ["threadId", "thread", "deliveryId", "id", "item", "corr", "server", "receiver", "kind"];

/** Every key an old call site could pass for `spec`: the ones the registry reads, the context ones, and the usual junk. */
const legacyKeys = (spec: EventSpec) => [
	...Object.entries(spec.fields).map(([n, f]) => f.from ?? n),
	...CONTEXT,
	...JUNK,
];

function fuzz(obs: Obs) {
	obs.allow("server", ["mac", "omar"]);
	obs.allow("receiver", ["desk"]);
	for (const [name, spec] of Object.entries(EVENTS)) {
		for (const poison of POISON) {
			const typed = Object.fromEntries([...Object.keys(spec.fields), ...JUNK].map((k) => [k, poison]));
			const log = makeLogger(obs, {
				mod: "fuzz",
				thread: poison as string,
				corr: poison as string,
				delivery: poison as string,
			});
			log.info(name as never, typed);
			log.warn(name as never, typed);
			const old = Object.fromEntries(legacyKeys(spec).map((k) => [k, poison]));
			makeLogger(obs, { mod: poison as string })(spec.legacy ?? name, old);
			obs.record("info", name, typed, { mod: "ledger" }, { sourceKey: `item:${poison}` as string });
		}
	}
}

describe("nothing secret-shaped is stored", () => {
	test("every registry event, every poison, both APIs: none of it is in any row or counter", () => {
		const obs = memObs();
		fuzz(obs);
		obs.flush();
		const dump = everything(obs);
		expect(dump.toLowerCase()).not.toContain(MARK.toLowerCase());
		expect(dump).not.toMatch(/Bearer|sk-ant|ghp_|eyJ|https?:|\/home\/|login bug|previous instructions/);
		expect(eventRows(obs).length).toBeGreaterThan(0);
		// The typed fields passed, so the rows exist; what was refused was counted.
		expect(obs.counters.rejected).toBeGreaterThan(1000);
	});

	test("the scrubber never had to act: log.redacted reads zero (a hit is a bug in the registry)", () => {
		const obs = memObs();
		fuzz(obs);
		expect(obs.counters.redacted).toBe(0);
		expect(obs.totals().redacted).toBe(0);
	});

	test("the same on disk: not a byte of obs.db or its write-ahead log holds it", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-fuzz-`);
		dirs.push(dir);
		const obs = memObs({ path: `${dir}/obs.db` });
		fuzz(obs);
		const wal = readdirSync(dir).filter((f) => f.startsWith("obs.db"));
		expect(wal).toContain("obs.db-wal");
		for (const f of wal)
			expect(readFileSync(`${dir}/${f}`).toString("latin1").toLowerCase()).not.toContain(MARK.toLowerCase());
		obs.close();
		for (const f of readdirSync(dir))
			expect(readFileSync(`${dir}/${f}`).toString("latin1").toLowerCase()).not.toContain(MARK.toLowerCase());
	});
});

/** A registry whose one event takes `value` as a member of an enum: the type check passes it, so only the scrubber stands between it and the file. */
const leaky = (value: string): Record<string, EventSpec> => ({
	"leak.test": { level: "info", fields: { value: { type: { kind: "enum", values: [value] } } } },
});

describe("the scrubber backstop, with the registry's own checks out of the way", () => {
	for (const [rule, v] of Object.entries(VECTORS)) {
		const value = v.value ?? "x";
		const field = v.key ?? "value";

		test(`${rule}: a value or key shaped like it is dropped from the row and counted, and a rule removed from RULES lets it through`, () => {
			const registry: Record<string, EventSpec> = v.key
				? { "leak.test": { level: "info", fields: { [field]: { type: { kind: "enum", values: ["x"] } } } } }
				: leaky(value);
			const obs = memObs({ registry });
			makeLogger(obs, { mod: "leak" }).info("leak.test" as never, { [field]: v.key ? "x" : value });
			expect(everything(obs)).not.toContain(MARK);
			expect(obs.counters.redacted).toBe(1);
			expect(eventRows(obs)).toHaveLength(1);
			expect(JSON.parse(eventRows(obs)[0]?.data ?? "{}")).toEqual({});
			// With every other rule in place and this one gone, the same call stores it: this rule is what stops it.
			const mutant = memObs({ registry, rules: RULES.filter((r) => r.name !== rule) });
			makeLogger(mutant, { mod: "leak" }).info("leak.test" as never, { [field]: v.key ? "x" : value });
			expect(mutant.counters.redacted).toBe(0);
			expect(JSON.parse(eventRows(mutant)[0]?.data ?? "{}")).toEqual({ [field]: v.key ? "x" : value });
		});
	}

	test("a column that matches a rule drops the whole row, and a source key that is no ledger key is refused", () => {
		const obs = memObs();
		obs.record("info", "decision.logged", { cited: 1 }, { mod: "sk-zqxmark0123456" });
		expect(eventRows(obs)).toEqual([]);
		expect(obs.counters.redacted).toBe(1);
		obs.record(
			"info",
			"decision.logged",
			{ cited: 1 },
			{ mod: "ledger" },
			{ sourceKey: "decision:ghp_0123456789abcdefghij" },
		);
		expect(eventRows(obs)).toEqual([]);
		expect(obs.counters.rejected).toBe(1);
	});
});

describe("every column, not only `data`", () => {
	const SHAPES: Record<string, RegExp> = {
		t: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/,
		level: /^(debug|info|warn|error)$/,
		host: /^[a-z0-9][a-z0-9-]{0,31}$/,
		run: /^[0-9a-f]{12}$/,
		mod: /^[a-z0-9][a-z0-9-]{0,31}$/,
		corr: /^[0-9a-f]{12}$/,
		delivery: /^[0-9a-f]{12}$/,
		thread: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
		source_key: /^(decision:\d+|item:Q-[a-z0-9]{4,16}:(asked|answered)|hold:[0-9a-f]{8}:closed)$/,
	};

	test("with poison in the time, the run, the host, the module and every context column, each column of each row still has its shape", () => {
		const obs = memObs({ debug: true, run: `Bearer ${MARK}`, host: `https://x.example/${MARK}` });
		obs.allow("server", ["mac"]);
		for (const poison of POISON) {
			const log = makeLogger(obs, {
				mod: poison as string,
				thread: poison as string,
				corr: poison as string,
				delivery: poison as string,
			});
			for (const name of ["wake.delivered", "fire", "answered", "wake.composed"] as const) {
				log.info(name, { http: 202 }, { t: poison as string });
				log(EVENTS[name].legacy ?? name, {
					t: poison,
					http: 202,
					id: poison,
					item: poison,
					deliveryId: poison,
					threadId: poison,
					server: "mac",
				});
			}
			obs.record(
				"info",
				"decision.logged",
				{ cited: 1 },
				{ mod: "ledger" },
				{ t: poison as string, sourceKey: poison as string },
			);
		}
		const rows = eventRows(obs);
		expect(rows.length).toBeGreaterThan(20);
		for (const r of rows)
			for (const [col, shape] of Object.entries(SHAPES)) {
				const v = (r as unknown as Record<string, string | null>)[col];
				if (v !== null) expect(`${col}=${v}`.slice(col.length + 1)).toMatch(shape);
			}
		expect(everything(obs).toLowerCase()).not.toContain(MARK.toLowerCase());
	});

	test("a host shaped like a credential is replaced and counted", () => {
		const obs = memObs({ host: "sk-abcdefghi" });
		makeLogger(obs, { mod: "relay" }).info("wake.delivered", { http: 202 });
		expect(eventRows(obs)[0]?.host).toBe("local");
		expect(obs.counters.redacted).toBe(1);
		expect(everything(obs)).not.toContain("sk-abcdefghi");
		const named = memObs({ host: "mac" });
		expect(named.host).toBe("mac");
		expect(named.counters.redacted).toBe(0);
	});

	test("a time the caller supplies is used only when it is a timestamp", () => {
		const obs = memObs();
		obs.record("info", "decision.logged", { cited: 1 }, { mod: "ledger" }, { t: "2026-11-01T00:00:00.000Z" });
		obs.record("info", "decision.logged", { cited: 1 }, { mod: "ledger" }, { t: "Bearer abc" });
		expect(eventRows(obs).map((r) => r.t)[0]).toBe("2026-11-01T00:00:00.000Z");
		expect(eventRows(obs)[1]?.t).not.toContain("Bearer");
		expect(obs.counters.rejected).toBe(1);
	});
});
