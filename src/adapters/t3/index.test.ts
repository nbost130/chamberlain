/** The T3 adapter's wiring (./index.ts): what it declares, and how each hook behaves when the thread ids or tokens are missing. */
import { describe, expect, test } from "bun:test";
import type { AdapterEnv } from "../../core/adapter.ts";
import { createT3Adapter, defaultT3Server, t3ServerLine } from "./index.ts";

const env = (over: Partial<AdapterEnv> = {}): AdapterEnv => ({
	server: { name: "mac", adapter: "t3", origin: "http://mac:3773", tokenFile: "read-token" },
	conf: "/nonexistent",
	state: "/nonexistent",
	log: () => {},
	alarm: () => {},
	steward: () => undefined,
	readPrivate: () => undefined,
	...over,
});

describe("createT3Adapter", () => {
	test("declares its id and every optional capability it implements, in order", () => {
		const a = createT3Adapter(env());
		expect(a.id).toBe("t3");
		expect(a.capabilities).toEqual([
			"answer",
			"listWaiting",
			"setTitle",
			"transcriptPath",
			"inspect",
			"send",
			"stewardProbe",
			"compact",
			"snapshot",
			"alertDesk",
			"handoffInstruction",
			"threadLinks",
		]);
		expect(a.approvalHint).toBe("The t3_pending_request tool cannot answer it.");
		expect(a.handoffInstruction?.()).toBe(
			"Run /steward-handoff now: rebuild the brief, start the fresh Steward thread and retire this one.",
		);
	});

	test("each adapter gets its own capability list", () => {
		const a = createT3Adapter(env());
		const b = createT3Adapter(env());
		expect(a.capabilities).not.toBe(b.capabilities);
	});

	test("with no Steward thread it reads idle and readable, and the desk is idle without a desk thread", () => {
		const a = createT3Adapter(env());
		expect(a.isBusy()).toBe("idle");
		expect(a.stewardProbe?.()).toEqual({ readable: true });
		expect(a.alertDesk?.isBusy()).toBe("idle");
	});

	test("the rename reports no-token without the Decisions thread or an operate token", async () => {
		const noThread = createT3Adapter(env());
		expect(await noThread.setTitle?.("x")).toBe("no-token");
		const noToken = createT3Adapter(env({ readPrivate: (n) => (n === "decisions-thread" ? "t1" : undefined) }));
		expect(await noToken.setTitle?.("x")).toBe("no-token");
	});

	test("the server line names the server, and says how a linked one is reached", () => {
		const a = createT3Adapter(env());
		expect(a.serverLine?.()).toBe("server: mac (this server)");
		expect(t3ServerLine({ name: "lap", environmentId: "env-1" })).toBe(
			"server: lap (linked: pass environmentId env-1 to the t3_* tools)",
		);
	});

	test("the default server is the local T3 on its usual port", () => {
		expect(defaultT3Server()).toMatchObject({ name: "local", adapter: "t3", tokenFile: "read-token" });
	});
});
