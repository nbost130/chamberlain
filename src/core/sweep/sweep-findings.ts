/** Pure parsers for one check's JSON findings (used by sweep.ts `parseCheckOutput`). */
import type { Finding } from "../items/source.ts";

const FINDING_FIELDS = new Set(["dedupKey", "text", "repeatIntervalMs", "maxNotifications", "baseline", "subject"]);

function checkFindingFields(x: Record<string, unknown>, n: number): void {
	if (!x || typeof x !== "object" || Array.isArray(x)) throw Error(`finding ${n} is not an object`);
	for (const k of Object.keys(x)) if (!FINDING_FIELDS.has(k)) throw Error(`finding ${n} has an unknown field "${k}"`);
}

function checkFindingRepeat(x: Record<string, unknown>, n: number): void {
	if (
		x.repeatIntervalMs !== undefined &&
		(typeof x.repeatIntervalMs !== "number" || !Number.isFinite(x.repeatIntervalMs) || x.repeatIntervalMs < 0)
	)
		throw Error(`finding ${n}: repeatIntervalMs must be a number of milliseconds, 0 or more`);
	if (
		x.maxNotifications !== undefined &&
		(typeof x.maxNotifications !== "number" ||
			!Number.isInteger(x.maxNotifications) ||
			x.maxNotifications < 1 ||
			x.repeatIntervalMs === undefined)
	)
		throw Error(`finding ${n}: maxNotifications must be a whole number, 1 or more, and goes with repeatIntervalMs`);
}

function findingSubject(x: Record<string, unknown>, n: number): { kind: string; id: string } | undefined {
	const subject = x.subject as { kind?: unknown; id?: unknown } | undefined;
	if (subject === undefined) return undefined;
	if (typeof subject !== "object" || typeof subject?.kind !== "string" || typeof subject?.id !== "string")
		throw Error(`finding ${n}: subject must be {"kind", "id"}`);
	return { kind: subject.kind, id: subject.id };
}

function parseFinding(x: Record<string, unknown>, i: number): Finding {
	const n = i + 1;
	checkFindingFields(x, n);
	if (typeof x.dedupKey !== "string" || !x.dedupKey || typeof x.text !== "string" || !x.text)
		throw Error(`finding ${n} needs a string dedupKey and text`);
	checkFindingRepeat(x, n);
	if (x.baseline !== undefined && typeof x.baseline !== "boolean")
		throw Error(`finding ${n}: baseline must be true or false`);
	const subject = findingSubject(x, n);
	return {
		dedupKey: x.dedupKey.slice(0, 200),
		text: x.text.slice(0, 400),
		...(x.repeatIntervalMs !== undefined ? { repeatIntervalMs: x.repeatIntervalMs as number } : {}),
		...(x.maxNotifications !== undefined ? { maxNotifications: x.maxNotifications as number } : {}),
		...(x.baseline === true ? { baseline: true } : {}),
		...(subject ? { subject } : {}),
	};
}

/**
 * Pure: the findings a check printed. A field this build does not know is refused, never ignored.
 */
export function parseCheckOutput(out: string): Finding[] {
	const raw = JSON.parse(out.trim() || "[]") as unknown;
	if (!Array.isArray(raw)) throw Error("its output is not a JSON array");
	return raw.map((x: Record<string, unknown>, i) => parseFinding(x, i));
}
