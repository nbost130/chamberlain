import { describe, expect, test } from "bun:test";
import { VECTORS } from "../../testing/secrets.ts";
import { hit, RULES, scrub } from "./scrub.ts";

describe("the scrubber's rules", () => {
	test("every rule has a vector here, and every vector names a rule", () => {
		expect(Object.keys(VECTORS).sort()).toEqual(RULES.map((r) => r.name).sort());
	});

	for (const rule of RULES) {
		const v = VECTORS[rule.name];
		const probe = v?.key ? { [v.key]: "x" } : { field: v?.value ?? "" };

		test(`${rule.name}: caught with every rule, and only caught by that rule`, () => {
			expect(scrub(probe).hits).toEqual([rule.name]);
		});

		test(`${rule.name}: mutation check, the vector gets through when that rule is removed`, () => {
			const without = RULES.filter((r) => r !== rule);
			const out = scrub(probe, without);
			expect(out.hits).toEqual([]);
			expect(out.clean).toEqual(probe);
		});
	}

	test("each name of the key rule is caught, in any case and with separators", () => {
		for (const k of [
			"token",
			"Token",
			"secretValue",
			"Authorization",
			"cookie",
			"PASSWORD",
			"api_key",
			"api-key",
			"apikey",
			"webToken",
		])
			expect(hit(k, 1)).toBe("secret-key");
		for (const k of ["server", "attempt", "http", "wait_ms"]) expect(hit(k, 1)).toBeUndefined();
	});

	test("the value rules look inside lists, and keep what they do not match", () => {
		const { clean, hits } = scrub({ members: ["0123456789ab", "Bearer abcdefghij"], ok: 3, name: "mac" });
		expect(hits).toEqual(["bearer"]);
		expect(clean).toEqual({ ok: 3, name: "mac" });
	});

	test("ordinary typed values are never hit", () => {
		const typical = {
			http: 202,
			attempt: 1,
			server: "mac",
			item: "Q-ab12cd34",
			corr: "0123456789ab",
			model: "claude-opus-5-5",
			kind: "needs_input",
		};
		expect(scrub(typical).hits).toEqual([]);
	});
});
