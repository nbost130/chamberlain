/** The rights record's size mark: an unread size is no shrink, a small dip is no compaction, a collapse is. */

import { describe, expect, test } from "bun:test";
import { AT, daemonWake, FULL } from "../../testing/core-rights-sent-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { rightsUnchanged } from "../decide/decide.ts";
import { rightsHighWater } from "./rights-sent.ts";

describe("what a wake carries after a size change", () => {
	test("must skip: a small dip under the mark (the reading wobbling, no compaction) sends the pointer", () => {
		const s = memStore();
		daemonWake(s, 200_000);
		expect(daemonWake(s, 170_000)).toBe(rightsUnchanged(AT));
	});
	test("must send: a collapse well under the mark (a compaction) sends them in full", () => {
		const s = memStore();
		daemonWake(s, 200_000);
		expect(daemonWake(s, 60_000)).toBe(FULL);
	});
	test("must send: a record that never saw a size has no mark to tell a shrink by, so they go in full", () => {
		const s = memStore();
		daemonWake(s, undefined);
		expect(daemonWake(s, 80_000)).toBe(FULL);
	});
});

describe("the minute's size check (rightsHighWater)", () => {
	const rec = { hash: "a".repeat(64), used: 200_000 };
	test("must keep: a size that could not be read leaves the record exactly as it is", () => {
		expect(rightsHighWater(rec, undefined)).toBe(rec);
	});
	test("must keep: the first size seen becomes the mark, and a dip never lowers it", () => {
		expect(rightsHighWater({ hash: rec.hash }, 150_000)).toEqual({ hash: rec.hash, used: 150_000 });
		expect(rightsHighWater(rec, 180_000)).toEqual(rec);
		expect(rightsHighWater(rec, 250_000)).toEqual({ ...rec, used: 250_000 });
	});
	test("must drop: a collapse under 80% of the mark is a compaction or a new thread", () => {
		expect(rightsHighWater(rec, 159_999)).toBeUndefined();
		expect(rightsHighWater(rec, 160_000)).toEqual(rec);
	});
	test("no record stays no record", () => {
		expect(rightsHighWater(undefined, 100_000)).toBeUndefined();
	});
});
