import { describe, expect, test } from "bun:test";
import { mergedPrs } from "./merged-prs.ts";

const SINCE = Date.parse("2026-11-10T00:00:00Z");
const item = (repo: string, n: number, m: string | null, t = `PR ${n}`) => ({
	r: `https://api.github.com/repos/${repo}`,
	n,
	m,
	t,
});

/** A GhRead that answers each search path from `pages[scope][page - 1]`, and records what it was asked. */
function fake(pages: Record<string, unknown[]>) {
	const asked: string[] = [];
	const gh = async (path: string) => {
		asked.push(decodeURIComponent(path));
		const q = /q=([^&]*)/.exec(path)?.[1] ?? "";
		const scope = decodeURIComponent(q).split(" ")[2] ?? "";
		const page = Number(/&page=(\d+)/.exec(path)?.[1]);
		const out = pages[scope]?.[page - 1];
		if (out instanceof Error) throw out;
		return out;
	};
	return { gh, asked };
}

describe("reading merged PRs", () => {
	test("searches each owner as user:<owner> and each repo as repo:<owner>/<name>, merged since the given time", async () => {
		const { gh, asked } = fake({
			"user:acme": [{ total: 1, incomplete: false, items: [item("acme/app", 1, "2026-11-17T10:00:00Z")] }],
			"repo:other/lib": [{ total: 0, incomplete: false, items: [] }],
		});
		const prs = await mergedPrs(gh, { owners: ["acme"], repos: ["other/lib"] }, SINCE);
		expect(prs).toEqual([{ repo: "acme/app", number: 1, mergedAt: Date.parse("2026-11-17T10:00:00Z"), title: "PR 1" }]);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toContain("is:pr is:merged user:acme merged:>=2026-11-10T00:00:00.000Z");
		expect(asked[1]).toContain("repo:other/lib");
	});

	test("reads every page of an owner", async () => {
		const full = (from: number) =>
			Array.from({ length: 100 }, (_, i) => item("acme/app", from + i, "2026-11-17T10:00:00Z"));
		const { gh, asked } = fake({
			"user:acme": [
				{ total: 130, incomplete: false, items: full(1) },
				{ total: 130, incomplete: false, items: full(101).slice(0, 30) },
			],
		});
		const prs = await mergedPrs(gh, { owners: ["acme"], repos: [] }, SINCE);
		expect(prs).toHaveLength(130);
		expect(asked).toHaveLength(2);
	});

	test("a search hit without its merge time makes the count unavailable", async () => {
		const { gh } = fake({ "user:acme": [{ total: 1, incomplete: false, items: [item("acme/app", 1, null)] }] });
		await expect(mergedPrs(gh, { owners: ["acme"], repos: [] }, SINCE)).rejects.toThrow("unreadable merged PR");
	});

	test("a bounded window asks GitHub for an ISO time range at second precision", async () => {
		const { gh, asked } = fake({ "repo:acme/app": [{ total: 0, incomplete: false, items: [] }] });
		const to = Date.parse("2026-11-17T00:00:00Z");
		await mergedPrs(gh, { owners: [], repos: ["acme/app"] }, SINCE + 999, to + 999);
		expect(asked[0]).toContain("merged:2026-11-10T00:00:00Z..2026-11-17T00:00:00Z");
	});

	test("nothing configured reads nothing", async () => {
		const { gh, asked } = fake({});
		expect(await mergedPrs(gh, { owners: [], repos: [] }, SINCE)).toEqual([]);
		expect(asked).toEqual([]);
	});
});

describe("fails closed", () => {
	test("refuses short pages, missing completeness and duplicate search hits", async () => {
		const p = item("acme/app", 1, "2026-11-17T10:00:00Z");
		for (const [reply, error] of [
			[{ total: 2, incomplete: false, items: [p] }, "incomplete page"],
			[{ total: 1, items: [p] }, "unexpected reply"],
			[{ total: 2, incomplete: false, items: [p, p] }, "repeated a merged PR"],
		] as const) {
			const { gh } = fake({ "user:acme": [reply] });
			await expect(mergedPrs(gh, { owners: ["acme"], repos: [] }, SINCE)).rejects.toThrow(error);
		}
	});
	test("a failed read rejects the whole read: a count that is too low is worse than none", async () => {
		const { gh } = fake({
			"user:acme": [{ total: 0, incomplete: false, items: [] }],
			"user:other": [new Error("GitHub read failed: rate limited")],
		});
		await expect(mergedPrs(gh, { owners: ["acme", "other"], repos: [] }, SINCE)).rejects.toThrow(/rate limited/);
	});

	test("more results than GitHub's search returns is refused, not truncated", async () => {
		const { gh } = fake({ "user:acme": [{ total: 1500, incomplete: false, items: [] }] });
		await expect(mergedPrs(gh, { owners: ["acme"], repos: [] }, SINCE)).rejects.toThrow(
			/more than GitHub's search returns/,
		);
	});

	test("an incomplete search and an unexpected reply are refused", async () => {
		const a = fake({ "user:acme": [{ total: 1, incomplete: true, items: [] }] });
		await expect(mergedPrs(a.gh, { owners: ["acme"], repos: [] }, SINCE)).rejects.toThrow(/incomplete/);
		const b = fake({ "user:acme": [{ nope: true }] });
		await expect(mergedPrs(b.gh, { owners: ["acme"], repos: [] }, SINCE)).rejects.toThrow(/unexpected reply/);
	});
});
