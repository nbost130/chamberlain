import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memStore } from "../../testing/store.ts";
import { queries } from "./database.ts";
import { openStore } from "./sqlite-store.ts";
import { makeUsage } from "./sqlite-usage.ts";
import type { WakeUsage } from "./store-records.ts";

const base: WakeUsage = {
	session: "native",
	wakeKey: "delivery",
	deliveryId: "delivery",
	kind: "sweep",
	startedAt: 1000,
	endedAt: 2000,
	requests: 1,
	compactions: 0,
	inputTokens: 100,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	outputTokens: 10,
};
const projected: WakeUsage = { ...base, session: "provider", wakeKey: "1", source: "turn record" };

test("delivery and overlapping timing deduplicate across sources even without a native session", () => {
	const store = memStore();
	try {
		const repeat = { ...base, wakeKey: "repeat", startedAt: 3000, endedAt: 4000 };
		const differentDelivery = { ...base, wakeKey: "different", deliveryId: "different" };
		store.usage.upsert([base, repeat, differentDelivery, projected]);
		expect(store.usage.list().map((row) => row.wakeKey)).toEqual(["different", "1", "repeat"]);
		expect(store.usage.list({ transcriptOnly: true })).toHaveLength(3);
	} finally {
		store.close();
	}
});

test("recent usage seeks by time in the state index and still reads existing keys", () => {
	const dir = mkdtempSync(join(tmpdir(), "chamberlain-usage-plan-"));
	try {
		const file = join(dir, "state.sqlite");
		openStore(file).close();
		using db = new Database(file);
		const c = queries(db);
		c.run("DROP INDEX IF EXISTS steward_meter_by_time");
		c.run("INSERT INTO state VALUES (?, ?, ?)", 'steward-meter:["provider","1"]', JSON.stringify(projected), 2000);
		c.run(
			"INSERT INTO state VALUES (?, ?, ?)",
			'steward-meter:["older","1"]',
			JSON.stringify({ ...projected, startedAt: 0 }),
			1,
		);
		openStore(file).close();
		const plans: string[] = [];
		const usage = makeUsage({
			...c,
			all: (sql, ...params) => {
				if (sql.includes("FROM state"))
					plans.push(...c.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => String(row.detail)));
				return c.all(sql, ...params);
			},
		});
		expect(usage.list({ since: 1000 })).toEqual([projected]);
		expect(plans.join("\n")).toMatch(/SEARCH state USING INDEX \w+ \(updated_at>\?\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
