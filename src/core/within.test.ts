/** `within`: the value of a call that answers in time, and a named timeout for one that does not. */
import { describe, expect, test } from "bun:test";
import { within } from "./within.ts";

describe("within", () => {
	test("passes the value of a call that answers before the deadline", async () => {
		expect(await within(Promise.resolve(7), 1000, "read")).toBe(7);
	});

	test("passes the rejection of a call that fails before the deadline", async () => {
		await expect(within(Promise.reject(Error("boom")), 1000, "read")).rejects.toThrow("boom");
	});

	test("rejects with the call's name and the deadline when nothing answers", async () => {
		await expect(within(new Promise<never>(() => {}), 5, "waiting-card read")).rejects.toThrow(
			"waiting-card read timed out after 5 ms",
		);
	});
});
