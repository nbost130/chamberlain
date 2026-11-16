/** C: opaque IDs (4). */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { min, T0, triageRig } from "../../testing/alert-triage-fixtures.ts";
import { HOSTILE_FIELDS, HOSTILE_STRINGS, ZQX } from "../../testing/alert-triage-hostile.ts";
import { runTriage } from "./alert-triage-cli.ts";
import { ALERT_TRIAGE } from "./alert-triage-config.ts";
import { alertKey, attemptId, ID_RE, occRef } from "./alert-triage-ids.ts";
import { obKey, seqKey } from "./alert-triage-obligation.ts";

const hex = (parts: unknown[], n: number) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, n);

describe("C opaque IDs", () => {
	test("C1 grammar", () => {
		for (let i = 0; i < 200; i++) {
			const source = HOSTILE_STRINGS[i % HOSTILE_STRINGS.length]!;
			const family = HOSTILE_STRINGS[(i * 3) % HOSTILE_STRINGS.length]!;
			const ak = alertKey(source, family);
			const ao = occRef(ak, i + 1);
			const att = attemptId(ao, i % 10);
			expect(ak).toMatch(ID_RE);
			expect(ao).toMatch(ID_RE);
			expect(att).toMatch(ID_RE);
		}
	});

	test("C2 source-scoped", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ source: "a", family: "f" }, { source: "b", family: "f", at: min(1) });
		r.settle(min(1));
		expect(r.obligations()).toHaveLength(2);
		r.append({ source: "a", family: "f", at: min(2) });
		r.settle(min(2));
		expect(r.obligations()).toHaveLength(2);
		expect(r.obligations().find((o) => o.event.source === "a")?.folded).toBe(1);
	});

	test("C3 digest equality, no markers", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({
			source: HOSTILE_FIELDS.source,
			family: HOSTILE_FIELDS.family,
			title: HOSTILE_FIELDS.title,
			body: HOSTILE_FIELDS.body,
		});
		r.settle(T0);
		const ak = alertKey(HOSTILE_FIELDS.source, HOSTILE_FIELDS.family);
		expect(ak).toBe(`ak_${hex(["chamberlain-alert-v1", HOSTILE_FIELDS.source, HOSTILE_FIELDS.family], 20)}`);
		const seq = r.store.items.get(ALERT_TRIAGE, seqKey(ak));
		const ob = r.store.items.get(ALERT_TRIAGE, obKey(ak));
		expect(seq?.dedupKey).toMatch(/^seq:ak_[0-9a-f]{20}$/);
		expect(ob?.dedupKey).toMatch(/^ob:ak_[0-9a-f]{20}$/);
		const ao = occRef(ak, 1);
		expect(ao).toBe(`ao_${hex(["occ", ak, 1], 20)}`);
		const ids = [
			ak,
			ao,
			attemptId(ao, 0),
			seq!.dedupKey,
			ob!.dedupKey,
			...r.stewardRows().map((row) => row.deliveryId),
			...r.stewardRows().flatMap((row) => row.members.map((m) => m.deliveryId)),
		];
		for (const id of ids) {
			expect(id).not.toContain(ZQX);
			expect(id).not.toContain("<<end alert-data>>");
			expect(id).not.toContain("sk-");
			expect(id).not.toContain("Bearer");
		}
	});

	test("C4 CLI ref validation", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({});
		r.settle(T0);
		const before = r.store.items.list({ source: ALERT_TRIAGE }).length;
		const err: string[] = [];
		expect(
			runTriage(
				r.store,
				["ack", "ao_0123456789abcdef0123; x"],
				() => {},
				(m) => err.push(m),
			),
		).toBe(2);
		expect(
			runTriage(
				r.store,
				["ack", "ao_0123456789abcdef0123\n"],
				() => {},
				() => {},
			),
		).toBe(2);
		expect(
			runTriage(
				r.store,
				["ack", "ak_0123456789abcdef0123"],
				() => {},
				() => {},
			),
		).toBe(2);
		expect(r.store.items.list({ source: ALERT_TRIAGE })).toHaveLength(before);
	});
});
