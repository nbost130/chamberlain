/** The rights record's size mark: an unread size keeps the record but a wake sent while it is unread carries the rights; any drop under the mark is a compaction. */

import { describe, expect, test } from "bun:test";
import { AT, daemonWake, FULL } from "../../testing/core-rights-sent-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { rightsUnchanged } from "../decide/decide.ts";
import { rightsHighWater } from "./rights-sent.ts";

describe("what a wake carries after a size change", () => {
	test("must skip: the same size, or a larger one, sends the pointer", () => {
		const s = memStore();
		daemonWake(s, 200_000);
		expect(daemonWake(s, 200_000)).toBe(rightsUnchanged(AT));
		expect(daemonWake(s, 230_000)).toBe(rightsUnchanged(AT));
	});
	test("must send: a size that could not be read just now carries them (a compaction may have happened and the newest turn has no usage yet)", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, undefined)).toBe(FULL);
	});
	test("must send: ANY drop under the mark (a compaction), however small, carries them in full", () => {
		const s = memStore();
		daemonWake(s, 200_000);
		expect(daemonWake(s, 199_999)).toBe(FULL);
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
	test("must keep: the first size seen becomes the mark, and the mark rises", () => {
		expect(rightsHighWater({ hash: rec.hash }, 150_000)).toEqual({ hash: rec.hash, used: 150_000 });
		expect(rightsHighWater(rec, 200_000)).toEqual(rec);
		expect(rightsHighWater(rec, 250_000)).toEqual({ ...rec, used: 250_000 });
	});
	test("must drop: any drop under the mark is a compaction or a new thread", () => {
		expect(rightsHighWater(rec, 199_999)).toBeUndefined();
		expect(rightsHighWater(rec, 60_000)).toBeUndefined();
	});
	test("no record stays no record", () => {
		expect(rightsHighWater(undefined, 100_000)).toBeUndefined();
	});
});
