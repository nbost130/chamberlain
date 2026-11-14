import { describe, expect, test } from "bun:test";
import { droppedJobs, isBypass } from "./hooks.ts";

describe("droppedJobs", () => {
	test("names each variable that drops jobs", () => {
		expect(droppedJobs({ LEFTHOOK_EXCLUDE: "test", LEFTHOOK_ONLY: "biome" })).toHaveLength(2);
	});
	test("allows an environment that drops nothing", () => {
		expect(droppedJobs({ LEFTHOOK_EXCLUDE: "", PATH: "/bin" })).toEqual([]);
	});
});

describe("isBypass", () => {
	const commit = { parents: 1, action: "commit", tree: "aaa" };
	test("a tree no pre-commit run verified is a bypass", () => {
		expect(isBypass(commit, ["bbb"])).toBe(true);
	});
	test("a verified tree is not", () => {
		expect(isBypass(commit, ["bbb", "aaa"])).toBe(false);
	});
	test("merges and replays make commits without pre-commit and are not bypasses", () => {
		expect(isBypass({ ...commit, parents: 2 }, [])).toBe(false);
		expect(isBypass({ ...commit, action: "cherry-pick" }, [])).toBe(false);
		expect(isBypass({ ...commit, action: "rebase (continue)" }, [])).toBe(false);
	});
});
