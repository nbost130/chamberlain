import { describe, expect, test } from "bun:test";
import { openStore } from "./sqlite-store.ts";

describe("prepare_pr_links (migration 18)", () => {
	test("link, listOpen, clear", () => {
		const s = openStore(":memory:");
		expect(s.preparePrLinks.link("thr-a", "run-1", "MemberHero", 1000)).toBe(true);
		expect(s.preparePrLinks.link("thr-a", "run-1", "MemberHero", 2000)).toBe(false);
		expect(s.preparePrLinks.listOpen()).toEqual([
			{ threadId: "thr-a", runId: "run-1", repo: "MemberHero", startedAt: 1000, clearedAt: null },
		]);
		expect(s.preparePrLinks.clear("thr-a", "run-1", 3000)).toBe(true);
		expect(s.preparePrLinks.listOpen()).toEqual([]);
		expect(s.preparePrLinks.get("thr-a", "run-1")).toEqual({
			threadId: "thr-a",
			runId: "run-1",
			repo: "MemberHero",
			startedAt: 1000,
			clearedAt: 3000,
		});
		expect(s.preparePrLinks.link("thr-a", "run-1", "MemberHero", 4000)).toBe(true);
		expect(s.preparePrLinks.listOpen("MemberHero")[0]!.startedAt).toBe(4000);
		s.close();
	});
});
