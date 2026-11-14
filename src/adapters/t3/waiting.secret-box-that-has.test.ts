/** waiting, continued: see waiting.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useAdaptersT3WaitingFixtures } from "../../testing/adapters-t3-waiting-fixtures.ts";
import { cardsFrom, secretWaits } from "./wait-cards.ts";

const { T } = useAdaptersT3WaitingFixtures();

describe("a secret box that has ended is not listed as waiting, as T3 counts it", () => {
	const secret = (over: Record<string, unknown> = {}) => ({
		type: "secret_request",
		status: "waiting",
		id: "turn-item:secret-request:t:k",
		label: "Read-only token",
		reason: "read the dashboard",
		runId: "run-1",
		secretStatus: "pending",
		...over,
	});
	test("pending, with its run live or not in the read: listed", () => {
		for (const runs of [
			[{ id: "run-1", status: "running" }],
			[{ id: "run-1", status: "waiting" }],
			[],
			[{ id: "run-2", status: "completed" }],
		])
			expect([
				runs,
				cardsFrom({ server: "main", canAnswer: true, thread: T }, [secret()], runs).map((c) => c.type),
			]).toEqual([runs, ["secret"]]);
		expect(
			cardsFrom({ server: "main", canAnswer: true, thread: T }, [
				secret({ secretStatus: undefined, runId: undefined }),
			]).map((c) => c.type),
		).toEqual(["secret"]);
	});
	test("its outcome is not pending (saved, declined, cancelled, or anything else): not listed, even if the item still says waiting", () => {
		for (const secretStatus of ["saved", "declined", "cancelled", "expired", "", null])
			expect([
				secretStatus,
				cardsFrom({ server: "main", canAnswer: true, thread: T }, [secret({ secretStatus })]),
			]).toEqual([secretStatus, []]);
	});
	test("its run has ended (the agent's wait timed out or died with it): not listed", () => {
		for (const status of ["completed", "failed", "cancelled", "interrupted", "rolled_back"])
			expect([
				status,
				cardsFrom({ server: "main", canAnswer: true, thread: T }, [secret()], [{ id: "run-1", status }]),
			]).toEqual([status, []]);
	});
	test("secretWaits is the same rule, alone; other kinds are untouched by it", () => {
		expect(secretWaits({ secretStatus: "pending", runId: "r" }, [{ id: "r", status: "running" }])).toBe(true);
		expect(secretWaits({ secretStatus: "pending", runId: "r" }, [{ id: "r", status: "completed" }])).toBe(false);
		expect(secretWaits({ secretStatus: "cancelled" })).toBe(false);
		const approval = { type: "approval_request", status: "waiting", requestId: "a1", prompt: "ls", runId: "run-1" };
		expect(
			cardsFrom({ server: "main", canAnswer: true, thread: T }, [approval], [{ id: "run-1", status: "completed" }]),
		).toHaveLength(1);
	});
});
