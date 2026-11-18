/**
 * A secret item's title, context, evidence and options are rewritten to stand-ins wherever a non-secret's would appear.
 */
import { describe, expect, test } from "bun:test";
import { redactSecretFields, SECRET_HOLD_WHAT, SECRET_TITLE, secretSafeHoldWhat } from "./secret-fields.ts";

const secret = {
	secret: true as const,
	title: "SYNTH-SECRET-TITLE-xyz",
	context: "SYNTH-SECRET-CONTEXT-xyz",
	options: [{ label: "SYNTH-SECRET-OPTION-xyz" }],
	evidence: [{ type: "link" as const, url: "https://example.test/synth-secret", caption: "SYNTH-SECRET-EVIDENCE-xyz" }],
	blocks: "SYNTH-SECRET-BLOCKS-xyz",
};

describe("redactSecretFields", () => {
	test("a secret loses its title, context, evidence, options and blocks", () => {
		const out = redactSecretFields(secret);
		expect(out.title).toBe(SECRET_TITLE);
		expect(out.context).toBe("");
		expect(out.options).toEqual([]);
		expect(out.evidence).toBeUndefined();
		expect(out.blocks).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain("SYNTH-SECRET");
	});
	test("a non-secret is unchanged", () => {
		const plain = { title: "Pick a plan", context: "details", options: [{ label: "A" }] };
		expect(redactSecretFields(plain)).toEqual(plain);
	});
});

describe("secretSafeHoldWhat", () => {
	test("a secret never carries the card label", () => {
		expect(secretSafeHoldWhat(true, "secret request", "SYNTH-SECRET-LABEL-xyz")).toBe(SECRET_HOLD_WHAT);
		expect(secretSafeHoldWhat(false, "secret request", "SYNTH-SECRET-LABEL-xyz")).toBe(
			"secret request: SYNTH-SECRET-LABEL-xyz",
		);
	});
});
