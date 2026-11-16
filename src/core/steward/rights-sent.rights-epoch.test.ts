/** rights-sent, continued: see rights-sent.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { AT, RULES, STEWARD } from "../../testing/core-rights-sent-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import {
	fullStamp,
	invalidateRights,
	loadRightsSent,
	parseRightsSent,
	RIGHTS_SENT_KEY,
	recordOf,
	rightsEpoch,
	rightsFor,
	rightsHash,
	rightsStamp,
	saveRightsSent,
} from "./rights-sent.ts";

describe("the rights epoch", () => {
	const hash = rightsHash(STEWARD, RULES);
	test("starts at 0, rises by one on each invalidation, which drops the record in the same write and never deletes the row", () => {
		const s = memStore();
		expect(rightsEpoch(s)).toBe(0);
		saveRightsSent({ hash, steward: STEWARD, epoch: 0 }, s);
		expect(invalidateRights(s)).toBe(1);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ epoch: 1 });
		expect(loadRightsSent(s)).toBeUndefined();
		expect(invalidateRights(s)).toBe(2);
		expect(rightsEpoch(s)).toBe(2);
	});
	test("a record for an older epoch is never stored over a newer one", () => {
		const s = memStore();
		invalidateRights(s);
		saveRightsSent({ hash, steward: STEWARD, epoch: 0 }, s);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ epoch: 1 });
		saveRightsSent({ hash, steward: STEWARD, epoch: 1 }, s);
		expect(loadRightsSent(s)).toEqual({ hash, steward: STEWARD, epoch: 1 });
	});
	test("an epoch that is not a whole number of 0 or more makes the record untrusted, and reads as 0", () => {
		for (const epoch of [-1, 1.5, "1", null]) expect(parseRightsSent({ hash, epoch })).toBeUndefined();
		const s = memStore();
		s.state.set(RIGHTS_SENT_KEY, { epoch: "7" });
		expect(rightsEpoch(s)).toBe(0);
	});
	test("a full stamp carries the epoch it was composed under, and the record it proves keeps it", () => {
		const { record } = rightsFor(undefined, {
			stewardId: STEWARD,
			rules: RULES,
			mandate: "",
			used: 10,
			now: AT,
			epoch: 3,
		});
		const full = fullStamp(record, STEWARD, "s1");
		expect(full.epoch).toBe(3);
		expect(recordOf(full).epoch).toBe(3);
		expect(rightsStamp(record, STEWARD, "s1").epoch).toBe(3);
	});
});
