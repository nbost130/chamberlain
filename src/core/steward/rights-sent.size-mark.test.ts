/**
 * The rights record is dropped on EVIDENCE the rights may be gone: a compaction counted since it was written (the daemon's, the harness's own or
 * a manual one) or a collapse of the context. An unreadable size, a small dip, or an unreadable count is not evidence.
 */

import { describe, expect, test } from "bun:test";
import { AT, daemonWake, FULL } from "../../testing/core-rights-sent-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { rightsUnchanged } from "../decide/decide.ts";
import { rightsHighWater } from "./rights-sent.ts";

describe("what a wake carries after a change", () => {
	test("must skip: the same size, a larger one, an unreadable one, or a small dip sends the pointer", () => {
		const s = memStore();
		daemonWake(s, 200_000, { compactions: 2 });
		for (const used of [200_000, 230_000, undefined, 170_000])
			expect(daemonWake(s, used, { compactions: 2 })).toBe(rightsUnchanged(AT));
	});
	test("must send: a compaction counted since the rights went carries them in full, with the size unreadable or unchanged", () => {
		const s = memStore();
		daemonWake(s, 200_000, { compactions: 2 });
		expect(daemonWake(s, undefined, { compactions: 3 })).toBe(FULL);
	});
	test("must send: a collapse of the context with no compaction counted (a large drop) carries them in full", () => {
		const s = memStore();
		daemonWake(s, 200_000, { compactions: 2 });
		expect(daemonWake(s, 60_000, { compactions: 2 })).toBe(FULL);
	});
	test("must skip: a count that could not be read now, or a record with no baseline, is no evidence", () => {
		const s = memStore();
		daemonWake(s, 200_000);
		expect(daemonWake(s, 200_000, { compactions: 9 })).toBe(rightsUnchanged(AT));
	});
});

describe("the minute's look (rightsHighWater)", () => {
	const rec = { hash: "a".repeat(64), used: 200_000, compactions: 2 };
	test("must keep: an unreadable size or count leaves the record exactly as it is", () => {
		expect(rightsHighWater(rec, undefined, undefined)).toBe(rec);
		expect(rightsHighWater(rec, undefined, 2)).toBe(rec);
	});
	test("must keep: the first size and the first count seen become the baselines, and the mark rises", () => {
		expect(rightsHighWater({ hash: rec.hash }, 150_000, 4)).toEqual({ hash: rec.hash, used: 150_000, compactions: 4 });
		expect(rightsHighWater(rec, 250_000, 2)).toEqual({ ...rec, used: 250_000 });
		expect(rightsHighWater(rec, 180_000, 2)).toBe(rec);
	});
	test("must drop: a compaction counted, or a collapse under 80% of the mark", () => {
		expect(rightsHighWater(rec, 200_000, 3)).toBeUndefined();
		expect(rightsHighWater(rec, undefined, 3)).toBeUndefined();
		expect(rightsHighWater(rec, 159_999, 2)).toBeUndefined();
		expect(rightsHighWater(rec, 160_000, 2)).toBe(rec);
	});
	test("no record stays no record", () => {
		expect(rightsHighWater(undefined, 100_000, 1)).toBeUndefined();
	});
});
