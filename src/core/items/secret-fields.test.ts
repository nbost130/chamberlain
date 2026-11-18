/**
 * A secret item's title, context, evidence and options are rewritten to stand-ins wherever a non-secret's would appear.
 */
import { describe, expect, test } from "bun:test";
import {
	redactSecretCard,
	redactSecretFields,
	SECRET_HOLD_WHAT,
	SECRET_TITLE,
	scrubSecretQuestionLine,
	secretSafeHoldWhat,
} from "./secret-fields.ts";

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

describe("redactSecretCard", () => {
	test("a mirrored secret drops its label/reason question; other kinds are unchanged", () => {
		const secret = {
			type: "secret",
			question: "SYNTH-MIRROR-LABEL · SYNTH-MIRROR-REASON",
			header: "Secret request",
			options: [{ label: "x" }],
		};
		expect(redactSecretCard(secret)).toEqual({
			type: "secret",
			question: SECRET_TITLE,
			header: "Secret request",
			options: [],
		});
		expect(JSON.stringify(redactSecretCard(secret))).not.toContain("SYNTH-MIRROR");
		const link = { type: "link", question: "pair machines", header: "Link", options: [] };
		expect(redactSecretCard(link)).toEqual(link);
	});
});

describe("scrubSecretQuestionLine", () => {
	test("replaces the question line with the stand-in title", () => {
		const raw = "item: Q-secr\nquestion: SYNTH-OLD-SECRET-TITLE\nthread: T";
		expect(scrubSecretQuestionLine(raw)).toBe(`item: Q-secr\nquestion: ${SECRET_TITLE}\nthread: T`);
		expect(scrubSecretQuestionLine(raw)).not.toContain("SYNTH-OLD-SECRET-TITLE");
	});
});
