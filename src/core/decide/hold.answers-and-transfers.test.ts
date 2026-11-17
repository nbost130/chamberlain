/** Answers forcing digests while transfers are held: neither starves the other. */
import { describe, expect, test } from "bun:test";
import { useCoreHoldFixtures } from "../../testing/core-hold-fixtures.ts";
import { fetchWake } from "../../testing/wake.ts";
import { createRelay } from "../delivery/relay.ts";

const { MIN, world } = useCoreHoldFixtures(createRelay, fetchWake);

describe("answers and a transfer backlog", () => {
	test("an answer every ten minutes to a busy Steward still lets the transfers out at the ceiling", async () => {
		const x = world();
		x.w.gate = "busy";
		for (let i = 0; i < 10; i++)
			x.store().wakes.hold({ deliveryId: `transfer:${i}:g3`, message: `old ${i}`, queuedAt: x.w.t, kind: "transfer" });
		const relay = x.relay();
		for (let m = 0; m < 60; m++) {
			if (m % 10 === 0) x.deliver("answer", `answer:item:Q-${m}`, { kind: "answer" });
			x.advance(MIN);
			await relay.pass();
		}
		const sent = x.w.accepted.map((w) => w.message);
		expect(sent.filter((m) => m.includes("decision-queue") || m.includes("answer")).length).toBeGreaterThan(0);
		expect(sent.some((m) => m.includes("old 0"))).toBe(true);
	});
});
