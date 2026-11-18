/**
 * #102: a pre-upgrade dismissal claim or held row that still carries a secret's real title must not ship it.
 */
import { describe, expect, test } from "bun:test";
import { item, queue } from "../../testing/core-questions-fixtures.ts";
import { composeWake } from "../decide/hold.ts";
import { type Claim, claimWake, enqueueClaim, PAGE, scrubSecretHeldMessages } from "./questions-claim.ts";
import { plainAnswer } from "./questions-wake.ts";
import { SECRET_TITLE } from "./secret-fields.ts";

const OLD_TITLE = "SYNTH-PREUPGRADE-SECRET-TITLE";

describe("enqueueClaim scrubs a secret's pre-upgrade wake (#102)", () => {
	test("a recovered claim whose stored message still names the secret title is held with the stand-in", () => {
		const id = "Q-secr1";
		const store = queue(item(id, { secret: true, title: OLD_TITLE, options: [], tag: "Secret" }));
		const stale = [
			`item: ${id}`,
			`question: ${OLD_TITLE}`,
			"thread: T (main)",
			"dismissed: already handled",
			"note: none",
		].join("\n");
		const claim: Claim = {
			owner: PAGE,
			item: id,
			deliveryId: `answer:item:${id}`,
			message: stale,
			t: "2026-11-01T12:00:00.000Z",
			answer: plainAnswer("dismissed", id, undefined, "2026-11-01T12:00:00.000Z"),
		};
		claimWake(store, claim);
		expect(enqueueClaim(store, claim, stale, 10)).toBe(true);
		const held = store.wakes.held(null).find((h) => h.deliveryId === claim.deliveryId);
		expect(held).toBeDefined();
		expect(held!.message).toContain(`question: ${SECRET_TITLE}`);
		expect(held!.message).not.toContain(OLD_TITLE);
	});
});

describe("scrubSecretHeldMessages before compose (#102)", () => {
	test("a held answer row that still names a secret title is scrubbed before composeWake ships it", () => {
		const id = "Q-secr2";
		const store = queue(item(id, { secret: true, title: OLD_TITLE, options: [], tag: "Secret" }));
		const stale = [
			`item: ${id}`,
			`question: ${OLD_TITLE}`,
			"thread: T (main)",
			"dismissed: already handled",
			"note: none",
		].join("\n");
		const held = [
			{
				deliveryId: `answer:item:${id}`,
				message: stale,
				queuedAt: 1,
				kind: "answer",
			},
			{
				deliveryId: "answer:item:Q-plain",
				message: "item: Q-plain\nquestion: Keep me\nthread: T",
				queuedAt: 2,
				kind: "answer",
			},
		];
		const safe = scrubSecretHeldMessages(store, held);
		expect(safe[0]!.message).toContain(`question: ${SECRET_TITLE}`);
		expect(safe[0]!.message).not.toContain(OLD_TITLE);
		expect(safe[1]!.message).toContain("Keep me");
		const composed = composeWake(safe, 10);
		expect(composed.message).not.toContain(OLD_TITLE);
		expect(composed.message).toContain(`question: ${SECRET_TITLE}`);
		expect(composed.message).toContain("Keep me");
	});
});
