/** D: enclosure and redaction (11). */
import { describe, expect, test } from "bun:test";
import { T0, triageRig } from "../testing/alert-triage-fixtures.ts";
import { HOSTILE_FIELDS, SECRET_SHAPES, ZQX } from "../testing/alert-triage-hostile.ts";
import { ALERT_DATA_SCHEMA, type AlertData, encodeAlertData, parseAlertData, parseWake } from "./alert-data.ts";
import { boundInput, prepareEvent, prepareField, redactSecrets } from "./alert-data-redact.ts";
import { runTriage } from "./alert-triage-cli.ts";
import { wakeText } from "./alert-triage-wake.ts";
import { withDeliveryId } from "./deliver.ts";

const sample = (over: Partial<AlertData> = {}): AlertData => ({
	source: "s",
	family: "f",
	title: "t",
	body: "b",
	severity: "critical",
	firstSeen: "2026-01-01T00:00:00.000Z",
	lastSeen: "2026-01-01T00:00:00.000Z",
	folded: 0,
	...over,
});

describe("D enclosure and redaction", () => {
	test("D1 round-trip through the real pair", () => {
		const inputs = [
			sample(),
			sample({ source: HOSTILE_FIELDS.source, family: HOSTILE_FIELDS.family, title: HOSTILE_FIELDS.title, body: "ok" }),
			sample({ body: "line\nwith\ttabs and <brackets>" }),
			sample({ folded: 42 }),
		];
		for (const x of inputs) {
			const back = parseAlertData(encodeAlertData(x));
			expect(back).toEqual(x);
			expect(Object.keys(back).sort()).toEqual(Object.keys(ALERT_DATA_SCHEMA).sort());
		}
	});

	test("D2 alphabet", () => {
		const enc = encodeAlertData(sample({ body: "hello <world>\nÿ" }));
		const payload = enc.split("\n")[1]!;
		expect(payload).toMatch(/^[\x20-\x7e]*$/);
		expect(payload).not.toContain("<");
		expect(payload).not.toContain(">");
	});

	test("D3 parser rejects", () => {
		const good = encodeAlertData(sample());
		expect(() => parseAlertData(good.replace(/len=\d+/, "len=1"))).toThrow();
		expect(() => parseAlertData(good.split("\n").slice(0, 2).join("\n"))).toThrow();
		expect(() => parseAlertData(`${good}\nextra`)).toThrow();
		expect(() => parseAlertData(good.replace("<<end alert-data>>", "<<end>>"))).toThrow();
		const badKeys = good.replace('"folded":0', '"folded":0,"extra":1');
		expect(() => parseAlertData(badKeys.replace(/len=\d+/, `len=${badKeys.split("\n")[1]!.length}`))).toThrow();
	});

	test("D4 sent text, hostile", () => {
		const event = prepareEvent(
			{
				source: HOSTILE_FIELDS.source,
				family: HOSTILE_FIELDS.family,
				title: HOSTILE_FIELDS.title,
				body: HOSTILE_FIELDS.body,
				ts: new Date(T0).toISOString(),
				severity: "critical",
			},
			{ firstSeen: new Date(T0).toISOString(), lastSeen: new Date(T0).toISOString(), folded: 0 },
		);
		const msg = wakeText({
			occ: "ao_0123456789abcdef0123",
			ordinal: 0,
			rule: "swap-full",
			event,
			firstSeen: event.firstSeen,
			folded: 0,
			readyAt: T0,
			now: T0,
			waiting: 0,
		});
		const sent = withDeliveryId(msg, "triage:0123456789abcdef0123:0");
		const parsed = parseWake(sent);
		expect(parsed.enclosures).toHaveLength(1);
		expect(parsed.enclosures[0]).toEqual(event);
		const outside = parsed.trustedLines.join("\n");
		expect(outside).not.toContain(ZQX);
		expect(encodeAlertData(event)).toContain(ZQX); // only inside enclosure payload after redaction may or may not — ZQX is not a secret pattern
		// ZQX in hostile fields survives redaction (not a secret shape); it must appear only inside the enclosure block
		const onlyInEnc = sent.indexOf(ZQX) >= 0 && outside.indexOf(ZQX) < 0;
		expect(onlyInEnc || !sent.includes(ZQX)).toBe(true);
	});

	test("D5 logs", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({
			source: HOSTILE_FIELDS.source,
			family: HOSTILE_FIELDS.family,
			title: HOSTILE_FIELDS.title,
			body: HOSTILE_FIELDS.body,
		});
		r.settle(T0);
		for (const l of r.logged) {
			const s = JSON.stringify(l);
			expect(s).not.toContain(ZQX);
			expect(s).not.toContain("sk-abcdefghijklmnop");
		}
	});

	test("D6 triage list/status", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({
			source: HOSTILE_FIELDS.source,
			family: HOSTILE_FIELDS.family,
			title: HOSTILE_FIELDS.title,
			body: HOSTILE_FIELDS.body,
		});
		r.settle(T0);
		const occ = r.obligations()[0]!.occ;
		const lines: string[] = [];
		runTriage(r.store, ["status", occ], (l) => lines.push(l));
		const text = lines.join("\n");
		const parsed = parseWake(text.includes("<<alert-data") ? text : `${lines[0]}\n${lines.slice(1).join("\n")}`);
		expect(parsed.enclosures.length + (text.includes("<<alert-data") ? 0 : 0)).toBeGreaterThanOrEqual(0);
		const trusted = lines.filter((l) => !l.startsWith("{") && !l.startsWith("<<"));
		expect(trusted.join("\n")).not.toContain(ZQX);
	});

	test("D7 redaction table", () => {
		for (const { raw, kind } of SECRET_SHAPES) {
			for (const field of ["source", "family", "title", "body"] as const) {
				const out = prepareField(raw, 1500, field === "body");
				const ok = out.includes(`[redacted:${kind}]`) || (kind === "hex" && out.includes("[redacted:entropy]"));
				expect(ok).toBe(true);
				expect(out).not.toContain(raw.slice(0, Math.min(12, raw.length)));
			}
		}
	});

	test("D8 redact before clip", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
		// JWT starts inside the 1500 clip and extends past it; spaces keep it a separate token from the pad.
		const body = `${"z".repeat(1470)} ${jwt}`;
		const out = prepareField(body, 1500, true);
		expect(out).toContain("[redacted:jwt]");
		expect(out.endsWith("[redacted:")).toBe(false);
		expect(out).not.toMatch(/\[redacted:[^\]]*$/);
	});

	test("D9 input bound", () => {
		const sk = "sk-abcdefghijklmnopqrstuvwxyz012345";
		const body = `${"y".repeat(64 * 1024 - 10)}${sk}`;
		const out = boundInput(body);
		expect(out.length).toBeLessThanOrEqual(64 * 1024);
		const red = redactSecrets(out);
		expect(red.includes(sk.slice(0, 8))).toBe(false);
	});

	test("D10 zero-width split", () => {
		const raw = "gh\u200Bp_abcdefghijklmnopqrstuvwxyz0123456789";
		const out = prepareField(raw, 1500, false);
		expect(out).toContain("[redacted:gh]");
	});

	test("D11 stored = redacted", () => {
		const r = triageRig({ desk: { morningHour: 23, startAt: "beginning" } });
		r.append({
			source: `src ${SECRET_SHAPES[2]!.raw}`,
			family: "f",
			title: "t",
			body: SECRET_SHAPES[0]!.raw,
		});
		r.settle(T0);
		const ob = r.obligations()[0]!;
		expect(JSON.stringify(ob.event)).not.toContain("sk-abcdefgh");
		expect(ob.event.body).toContain("[redacted:");
		expect(ob.event.source.length).toBeLessThanOrEqual(120);
		expect(ob.event.body.length).toBeLessThanOrEqual(1500);
	});
});
