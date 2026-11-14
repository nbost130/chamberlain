import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { formatButlers, liveButlers, readButlers, startButler, stopButler } from "./butler.ts";

const T = (s: string) => new Date(`2026-11-11T${s}Z`);
const f = { thread: "thr-1", machine: "remote", model: "small-model", scope: "watch 10 PRs and report the green ones" };

describe("butler ledger", () => {
	test("start records one butler and returns it, with a generated id when none is given", () => {
		const store = memStore();
		const b = startButler(store, { ...f, id: "B-one" }, T("10:00:00"));
		expect(b).toEqual({ id: "B-one", ...f, started: "2026-11-11T10:00:00.000Z" });
		expect(readButlers(store)).toEqual([b]);
		expect(startButler(store, f, T("10:01:00")).id).toMatch(/^B-[0-9a-f]{6}$/);
	});

	test("stop marks a butler and rewrites nothing else; list shows the live ones, --all shows both", () => {
		const store = memStore();
		startButler(store, { ...f, id: "B-one" }, T("10:00:00"));
		startButler(store, { ...f, id: "B-two", machine: "laptop", model: "large-model" }, T("10:05:00"));
		const r = stopButler(store, "B-one", "list empty", T("11:00:00"));
		expect(r).toMatchObject({
			already: false,
			butler: { id: "B-one", stopped: "2026-11-11T11:00:00.000Z", reason: "list empty" },
		});
		expect(liveButlers(store).map((b) => b.id)).toEqual(["B-two"]);
		expect(readButlers(store).map((b) => [b.id, b.stopped])).toEqual([
			["B-one", "2026-11-11T11:00:00.000Z"],
			["B-two", undefined],
		]);
		const text = formatButlers(liveButlers(store), T("11:05:00").getTime());
		expect(text).toContain("B-two\tlive 60m\tlaptop\tlarge-model\tthread thr-1");
		expect(formatButlers([])).toBe("no butlers");
	});

	test("a second stop changes nothing and says so; an unknown id, a duplicate id and a missing field are refused", () => {
		const store = memStore();
		startButler(store, { ...f, id: "B-one" }, T("10:00:00"));
		stopButler(store, "B-one", undefined, T("11:00:00"));
		const before = readButlers(store);
		const again = stopButler(store, "B-one", "again", T("12:00:00"));
		expect(again).toMatchObject({ already: true, butler: { stopped: "2026-11-11T11:00:00.000Z" } });
		expect(() => stopButler(store, "B-nope")).toThrow("no butler B-nope");
		expect(() => startButler(store, { ...f, id: "B-one" })).toThrow("already in the ledger");
		expect(() => startButler(store, { ...f, scope: " " })).toThrow("--scope is required");
		expect(readButlers(store)).toEqual(before);
	});

	test("an empty ledger lists nothing", () => {
		expect(readButlers(memStore())).toEqual([]);
	});
});
