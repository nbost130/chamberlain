import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, EVENTS, FAMILIES } from "./registry.ts";
import { RULES } from "./scrub.ts";

const SRC = new URL("../..", import.meta.url).pathname;

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name))
			: e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
				? [join(dir, e.name)]
				: [],
	);

describe("the registry", () => {
	test("every event has a plain name, a level, and fields that no scrubber rule would drop", () => {
		const keyRule = RULES.find((r) => r.name === "secret-key")?.key as RegExp;
		for (const [name, spec] of Object.entries(EVENTS)) {
			expect(name).toMatch(/^[a-z][a-z0-9.-]*$/);
			expect(["debug", "info", "warn", "error"]).toContain(spec.level);
			for (const [field, f] of Object.entries(spec.fields)) {
				expect(`${name}.${field}`).not.toMatch(/\s/);
				expect(keyRule.test(field)).toBe(false);
				expect(f.type.kind).not.toBe("string" as never);
			}
		}
	});

	test("a field named for a duration is a duration, and the registry's types are pinned: loosening one changes this listing and fails until the snapshot is updated on purpose", () => {
		const lines: string[] = [];
		const show = (t: { kind: string; values?: readonly string[]; set?: string; of?: unknown; max?: number }): string =>
			t.kind === "enum"
				? `enum(${t.values?.join("|")})`
				: t.kind === "known"
					? `known(${t.set})`
					: t.kind === "list"
						? `list(${show(t.of as never)},${t.max})`
						: t.kind;
		for (const [name, spec] of Object.entries(EVENTS)) {
			for (const [field, f] of Object.entries(spec.fields)) {
				if (field.endsWith("_ms")) expect(f.type.kind).toBe("ms");
				lines.push(`${name}.${field}: ${show(f.type)}${f.from ? ` <- ${f.from}` : ""}${f.via ? ` (${f.via})` : ""}`);
			}
		}
		expect(lines.join("\n")).toMatchSnapshot();
	});

	test("legacy names are unique and never shadow another event's name", () => {
		const legacy = Object.values(EVENTS).flatMap((s) => (s.legacy ? [s.legacy] : []));
		expect(new Set(legacy).size).toBe(legacy.length);
		for (const l of legacy) expect(l in EVENTS).toBe(false);
	});

	test("a name resolves to itself, a legacy name to its event, and anything else to nothing", () => {
		expect(canonical("wake.delivered")).toBe("wake.delivered");
		expect(canonical("delivered")).toBe("wake.delivered");
		expect(canonical("composed")).toBe("wake.composed");
		expect(canonical("title")).toBeUndefined();
		expect(canonical("constructor")).toBeUndefined();
		expect(canonical("__proto__")).toBeUndefined();
	});

	test("no field of any event is a free string: every type is an identifier, a member of a set, a number or a flag", () => {
		const kinds = new Set<string>();
		const walkType = (t: { kind: string; of?: unknown }) => {
			kinds.add(t.kind);
			if (t.of) walkType(t.of as { kind: string });
		};
		for (const spec of Object.values(EVENTS)) for (const f of Object.values(spec.fields)) walkType(f.type);
		expect([...kinds].sort()).toEqual(["bool", "enum", "hex12", "int", "item", "known", "list", "ms"]);
	});

	test("the transition families name events and sets the registry has, and a field that is no family's has no `enters` or `leaves`", () => {
		for (const fam of Object.values(FAMILIES)) {
			expect((EVENTS as Record<string, unknown>)[fam.event]).toBeDefined();
			expect(fam.states.length).toBeGreaterThan(1);
		}
		for (const spec of Object.values(EVENTS))
			for (const edge of [spec.enters, spec.leaves]) if (edge) expect(FAMILIES[edge.family]).toBeDefined();
	});
});

describe("every event the code logs is registered", () => {
	/** The event names the existing call sites pass as a string literal. */
	const literals = () => {
		const found = new Set<string>();
		const call =
			/(?:\blog|\.log|\bsink\.log|\bd\.log|\bc\.log|\bo\.log|\brc\.d\.log|\br\.d\.log)\??\.?\(\s*["']([a-z][a-z0-9-]*)["']/g;
		for (const file of walk(SRC)) {
			if (file.includes("/testing/")) continue;
			for (const m of readFileSync(file, "utf8").matchAll(call)) found.add(m[1] as string);
		}
		return found;
	};
	/** Names chosen at run time (history.ts's skipEvent, relay's held and queued, the recovery's ask, compaction): listed here so the scan has them. */
	const computed = [
		"skip-children-running",
		"skip-turn-ended",
		"skip-read-failed",
		"skip-read-truncated",
		"skip-report-superseded",
		"skip-empty",
		"deliver-held",
		"deliver-queued",
		"recover-breaker-alarm",
		"recover-ask",
		"skip-compact",
		"compact-clear",
		"config-legacy-reappeared",
		"schema-migrated",
		"schema-migrate-skipped",
	];

	test("the scan finds the calls it is meant to find", () => {
		const names = literals();
		expect(names.size).toBeGreaterThan(80);
		for (const must of ["fire", "delivered", "composed", "session-error", "connected", "answered"])
			expect(names.has(must)).toBe(true);
	});

	test("each name a call site uses is a registry event or a registry event's legacy name", () => {
		const unregistered = [...literals(), ...computed].filter((n) => canonical(n) === undefined);
		// `opened`, `held` and `heartbeat:` are printed by tools and tests, not logged.
		expect(unregistered.filter((n) => !["opened", "held", "heartbeat"].includes(n))).toEqual([]);
	});
});
