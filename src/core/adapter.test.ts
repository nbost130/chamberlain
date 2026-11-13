import { describe, expect, test } from "bun:test";
import { createFakeAdapter, ALL_CAPABILITIES } from "../testing/fake-adapter.ts";
import { conformance, has, normalizeThread, type Adapter } from "./adapter.ts";

describe("normalizeThread", () => {
	test("fills every optional field with its neutral value", () => {
		expect(normalizeThread({ id: "t", title: "T", status: "running" })).toEqual({
			id: "t", title: "T", status: "running", parentThreadId: null, pendingRequestId: null, settled: false, archived: false, snoozed: false,
			blockedOnThreadWait: false, openPrs: [], worktreePath: null, linkedPrDone: false, backgroundTasks: 0, backgroundWork: 0, latestRunId: null,
		});
	});
	test("keeps what the backend provides", () => {
		expect(normalizeThread({ id: "t", title: "T", status: "waiting", pendingRequestId: "r", openPrs: [4], parentThreadId: "p", backgroundWork: 2 })).toMatchObject({ pendingRequestId: "r", openPrs: [4], parentThreadId: "p", backgroundWork: 2 });
	});
});

describe("conformance", () => {
	test("the fake conforms with no optional capability, with all of them, and with each one alone", () => {
		expect(conformance(createFakeAdapter({ capabilities: [] }))).toEqual([]);
		expect(conformance(createFakeAdapter())).toEqual([]);
		for (const cap of ALL_CAPABILITIES) expect(conformance(createFakeAdapter({ capabilities: [cap] }))).toEqual([]);
	});
	test("`has` is true exactly for the declared capabilities", () => {
		const a = createFakeAdapter({ capabilities: ["send", "inspect"] });
		for (const cap of ALL_CAPABILITIES) expect(has(a, cap)).toBe(cap === "send" || cap === "inspect");
	});
	test("a declared capability with no method, a method with no declaration, an unknown name and a missing required part are all reported", () => {
		const base = createFakeAdapter({ capabilities: [] });
		const lie = (o: Omit<Partial<Adapter>, "capabilities"> & { capabilities: readonly string[] }) => conformance({ ...base, ...o } as unknown as Adapter);
		expect(lie({ capabilities: ["answer"] })).toEqual(["declares answer but does not implement it"]);
		expect(lie({ capabilities: [], setTitle: async () => "set" })).toEqual(["implements setTitle but does not declare it"]);
		expect(lie({ capabilities: ["telepathy"] })).toEqual(["declares unknown capability telepathy"]);
		expect(lie({ capabilities: [], wake: undefined as never })).toEqual(["required capability wake needs ready() and send()"]);
		expect(lie({ capabilities: [], watch: undefined as never })).toEqual(["required method watch is missing"]);
		expect(lie({ capabilities: [], id: "" })).toEqual(["no id"]);
	});
});
