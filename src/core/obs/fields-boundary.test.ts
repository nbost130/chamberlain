/** Every field of every registered event, at its type's edges: a type loosened by one notch (`Ms` to `Int`, an enum to a string) fails here. */
import { describe, expect, test } from "bun:test";
import { eventRows, memObs } from "../../testing/obs.ts";
import type { FieldType } from "./fields.ts";
import { makeLogger } from "./logger.ts";
import { EVENTS, type EventName } from "./registry.ts";

/** A value the type accepts, and values it must refuse. */
function samples(t: FieldType): { good: unknown; bad: unknown[] } {
	switch (t.kind) {
		case "ms":
			return { good: 0, bad: [-1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY] };
		case "int":
			return { good: -3, bad: [1.5, "1", Number.NaN, 2 ** 60, true] };
		case "bool":
			return { good: false, bad: [0, 1, "true", "false"] };
		case "uuid":
			return {
				good: "0b6c1a52-5a1e-4c0f-9d31-7a2f2b3c4d5e",
				bad: ["thread-1", "0b6c1a52-5a1e-4c0f-9d31-7a2f2b3c4d5", "Fix it"],
			};
		case "hex12":
			return { good: "0123456789ab", bad: ["0123456789a", "0123456789abc", "0123456789AB", "0123456789ag"] };
		case "item":
			return { good: "Q-ab12cd34", bad: ["Q-", "q-ab12cd34", "Q-ab 12", "ab12cd34"] };
		case "model":
			return { good: "claude-opus-5-5", bad: ["", "a/b", "0123456789abcdef0123456789abcdef"] };
		case "enum":
			return { good: t.values[0], bad: ["zz-not-a-member", `${t.values[0]} `, 5] };
		case "known":
			return { good: "kk", bad: ["zz-not-allowed", 5] };
		case "list":
			return {
				good: [samples(t.of).good],
				bad: ["x", [samples(t.of).bad[0]], Array(t.max + 1).fill(samples(t.of).good)],
			};
	}
}

describe("each registered field refuses what its type refuses and keeps what it accepts", () => {
	for (const [name, spec] of Object.entries(EVENTS)) {
		for (const [field, f] of Object.entries(spec.fields)) {
			test(`${name}.${field} (${f.type.kind})`, () => {
				const { good, bad } = samples(f.type);
				const obs = memObs();
				obs.allow("server", ["kk"]);
				obs.allow("receiver", ["kk"]);
				obs.allow("set", ["kk"]);
				const log = makeLogger(obs, { mod: "probe" });
				log.info(name as EventName, { [field]: good });
				const stored = eventRows(obs).map((r) => JSON.parse(r.data) as Record<string, unknown>);
				// A known set this probe did not name still refuses: only the sets the engine allows are probed.
				if (f.type.kind !== "known" || ["server", "receiver"].includes(f.type.set))
					expect(stored).toEqual([{ [field]: good }]);
				for (const b of bad) {
					const before = eventRows(obs).length;
					const rejected = obs.counters.rejected;
					log.info(name as EventName, { [field]: b });
					const row = eventRows(obs).slice(before)[0];
					expect(row ? JSON.parse(row.data) : {}).toEqual({});
					expect(obs.counters.rejected).toBe(rejected + 1);
				}
			});
		}
	}
});
