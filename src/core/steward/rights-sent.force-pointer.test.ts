/** forcePointer: holdable producers never embed the full rights block. */

import { describe, expect, test } from "bun:test";
import { AT, RULES, STEWARD } from "../../testing/core-rights-sent-fixtures.ts";
import { rightsUnchanged } from "../decide/decide.ts";
import { needsRights, rightsFor, rightsHash, rightsStamp } from "./rights-sent.ts";

describe("forcePointer never returns the full block", () => {
	test("with no record, and after a gap that would send full, the body is the pointer and full is false", () => {
		const none = rightsFor(undefined, {
			stewardId: STEWARD,
			rules: RULES,
			mandate: "",
			used: 80_000,
			forcePointer: true,
		});
		expect(none.full).toBe(false);
		expect(none.text).toBe(rightsUnchanged(undefined));
		expect(none.record.hash).toBe(rightsHash(STEWARD, RULES));
		expect(needsRights([rightsStamp(none.record, STEWARD, "s")])).toBe(true);

		const afterFull = rightsFor(
			{ hash: rightsHash(STEWARD, "old"), used: 80_000, at: AT },
			{ stewardId: STEWARD, rules: RULES, mandate: "", used: 40_000, forcePointer: true },
		);
		expect(afterFull.full).toBe(false);
		expect(afterFull.text).toBe(rightsUnchanged(AT));
	});
});
