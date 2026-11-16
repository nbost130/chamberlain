/**
 * Slim holdable turn_ended: pointer rights + no Last-message fence (investigation R98).
 * Gap filling stays on the rights-first path, not in each held body.
 */

import { describe, expect, test } from "bun:test";
import { useCoreEngineExtraFixtures } from "../../testing/core-engine-extra-fixtures.ts";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { RIGHTS_MARKER } from "../decide/decide.ts";
import { composeWake } from "../decide/hold.ts";
import { needsRights } from "../steward/rights-sent.ts";
import { encodedSendBytes, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import { createEngine } from "./engine.ts";

const { rig, thread, stewardSigned } = useCoreEngineFixtures(createEngine);
const { waitingOn } = useCoreEngineExtraFixtures(createEngine);

const posts = (r: ReturnType<typeof rig>) => r.fake.wakes.filter((w) => !w.deliveryId.includes(":rights-first:"));

const ended = (r: ReturnType<typeof rig>, id: string, lastMessage: string) => {
	r.fake.threads.set(id, {
		instruction: { items: [{ ...stewardSigned, id: `s-${id}` }], state: "complete", byMachine: false },
		lastMessage,
	});
	r.fake.emit({ kind: "state", thread: thread(id, "running") });
	r.fake.emit({ kind: "state", thread: thread(id, "completed") });
};

describe("slim turn_ended producer (pointer wake)", () => {
	test("after a rights gap (full would apply), held turn_ended lacks RIGHTS_MARKER, has the pointer line, stamp needsRights", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		// Establish a full record via needs_input, then wipe it (gap) so rightsInFull would be true.
		waitingOn(r, "t0", "req-0");
		await r.until("seed full", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain(RIGHTS_MARKER);
		r.store.state.set("rights-sent", { epoch: 1 });
		r.fake.setBusy("busy");
		r.fake.probe = { readable: true, contextTokens: 2000 };
		ended(r, "t1", "A long final that must not appear in the wake. ".repeat(40));
		await r.until("held", () => r.held().length === 1);
		const held = r.held()[0]!;
		expect(held.message).not.toContain(RIGHTS_MARKER);
		expect(held.message).toContain("Decision rights and rulings unchanged since");
		expect(held.message).not.toContain("Last message");
		expect(held.message).not.toContain("A long final that must not appear");
		expect(held.message).toContain("server: fake");
		expect(held.message).toContain("threadId: t1");
		expect(held.deliveryId).toContain("t1:ended:");
		expect(needsRights(held.rights)).toBe(true);
		expect(held.rights?.[0]?.full).toBeUndefined();
	});

	test("four synthetic pointer turn_ended bodies compose under the encoded 24kB cap", () => {
		const pointer =
			`[chamberlain] turn_ended: thread "MemberOS #7572" finished a turn on the work you sent it and has gone quiet.\n` +
			`server: home (this server)\n` +
			`threadId: mcp:launch:abc  (top-level)\n` +
			`Decision rights and rulings unchanged since 2026-11-15T01:00:00.000Z and still in force; your hand-off (steward-brief.md) has them.`;
		expect(Buffer.byteLength(pointer, "utf8")).toBeLessThan(700);
		const parts = [1, 2, 3, 4].map((n) => ({
			deliveryId: `mcp:launch:test:ended:run-${n}`,
			message: pointer.replace("MemberOS #7572", `t${n}`).replace("mcp:launch:abc", `thread-${n}`),
			queuedAt: n,
			kind: "turn_ended" as const,
			thread: `thread-${n}`,
		}));
		const all = composeWake(parts, 1);
		expect(encodedSendBytes(all.message, all.deliveryId)).toBeLessThan(TRANSFER_DIGEST_MAX_BYTES);
		expect(encodedSendBytes(all.message, all.deliveryId)).toBeLessThan(4_000);
		// Contrast: four full-rights-sized bodies still blow the cap (composeDigestBatch safety net).
		const fat = parts.map((p) => ({ ...p, message: `${p.message}\n${RIGHTS_MARKER}\n${"x".repeat(8_500)}` }));
		const fatWake = composeWake(fat, 1);
		expect(encodedSendBytes(fatWake.message, fatWake.deliveryId)).toBeGreaterThan(TRANSFER_DIGEST_MAX_BYTES);
	});

	test("busy→idle with a rights gap: pointer-held digest POSTs after one rights-first; land writes rights-sent from that full stamp", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t0", "req-0");
		await r.until("seed", () => r.fake.wakes.length === 1);
		const seedHash = (r.store.state.get("rights-sent") as { hash: string }).hash;
		r.store.state.set("rights-sent", { epoch: 7 });
		r.fake.setBusy("busy");
		r.clock.t += 30_000;
		r.fake.probe = { readable: true, contextTokens: 3000 };
		ended(r, "t2", "done");
		ended(r, "t3", "done");
		await r.until("both held", () => r.held().length === 2);
		expect(r.held().every((h) => needsRights(h.rights))).toBe(true);
		expect(r.held().every((h) => !h.message.includes(RIGHTS_MARKER))).toBe(true);
		r.fake.setBusy("idle");
		await r.engine.tick();
		await r.until("rights-first then digest", () => posts(r).some((w) => w.deliveryId.startsWith("digest:")));
		const first = r.fake.wakes.find((w) => w.deliveryId.includes(":rights-first:"));
		expect(first).toBeDefined();
		expect(first!.message).toContain(RIGHTS_MARKER);
		const digest = posts(r).find((w) => w.deliveryId.startsWith("digest:"))!;
		expect(digest.message).not.toContain(RIGHTS_MARKER);
		expect(digest.message).toContain("Decision rights and rulings unchanged since");
		// Record comes from the rights-first full stamp's land, not from the digest body.
		expect(r.store.state.get("rights-sent")).toMatchObject({
			steward: "steward-1",
			hash: seedHash,
			epoch: 7,
		});
		expect(r.events.some((e) => e.event === "rights-first" && String(e.deliveryId).startsWith("digest:"))).toBe(true);
	});

	test("regression: server, threadId, deliveryId and run-keyed fold still present without the excerpt", async () => {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t0", "req-0");
		await r.until("seed", () => r.fake.wakes.length === 1);
		r.clock.t += 30_000;
		r.fake.probe = { readable: true, contextTokens: 2000 };
		const id = "mcp:fold-run";
		r.fake.threads.set(id, {
			instruction: {
				items: [{ ...stewardSigned, id: "s-fold", runId: "run-9" }],
				state: "complete",
				byMachine: false,
			},
			lastMessage: "excerpt must stay out of the wake body",
			runMessages: { "run-9": "excerpt must stay out of the wake body" },
			runs: [{ id: "run-9", ordinal: 9, status: "completed" }],
		});
		r.fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: "run-9" }) });
		r.fake.emit({ kind: "state", thread: thread(id, "completed", { latestRunId: "run-9" }) });
		await r.until("report", () => posts(r).some((w) => w.message.includes("threadId: mcp:fold-run")));
		const w = posts(r).find((x) => x.message.includes("threadId: mcp:fold-run"))!;
		expect(w.message).toContain("server: fake");
		expect(w.message).toContain("threadId: mcp:fold-run");
		expect(w.deliveryId).toContain(":ended:run-9:");
		expect(w.message).not.toContain("Last message");
		expect(w.message).not.toContain("excerpt must stay out");
	});
});
