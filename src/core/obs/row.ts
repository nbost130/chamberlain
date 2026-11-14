/**
 * From a log call's fields to the row's `data` and columns, with nothing that is not typed. Pure: obs.ts decides what to do with the result.
 *
 * Typed callers (`log.info("wake.delivered", { http: 202 })`) are strict: a field the registry does not list is rejected. The existing call sites
 * (`log("delivered", { deliveryId, error: String(e), title })`) are read through the registry's `from` and `via`: only the keys it names are looked at.
 */
import { BAD, check, corrOf, errClass, type FieldValue, type Known, own } from "./fields.ts";
import type { EventSpec, FieldSpec } from "./registry.ts";

/** What a call is about, kept as columns and not in `data`: the thread (a UUID), a delivery id (kept as its digest), the correlation id. */
export type Ctx = { mod?: string; thread?: string; corr?: string; delivery?: string };
/** The columns, validated: `delivery` and `corr` are digests, `thread` a UUID. */
export type Columns = { thread: string | null; corr: string | null; delivery: string | null };
export type Projected = { data: Record<string, FieldValue>; rejected: number };

const ANSWER_DELIVERY = /^answer:item:(Q-[a-z0-9]{4,16})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM = /^Q-[a-z0-9]{4,16}$/;
const HEX12 = /^[0-9a-f]{12}$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The correlation id of a raw delivery id: an answer's wake joins its question (`item:<id>`), anything else is its own digest. */
function corrOfDelivery(raw: string): string {
	const item = ANSWER_DELIVERY.exec(raw)?.[1];
	return corrOf(item ? `item:${item}` : raw);
}

/** The columns a legacy call's fields and its bound context give. A thread that is not a UUID is dropped and counted. */
export function columnsOf(input: Record<string, unknown>, bound: Ctx): { cols: Columns; rejected: number } {
	let rejected = 0;
	const rawThread = str(input.threadId) ?? str(input.thread) ?? str(bound.thread);
	const thread = rawThread !== undefined && UUID.test(rawThread) ? rawThread.toLowerCase() : null;
	if (rawThread !== undefined && thread === null) rejected++;
	const rawDelivery = str(input.deliveryId) ?? str(bound.delivery);
	const delivery = rawDelivery !== undefined ? corrOf(rawDelivery) : null;
	const item = [input.item, input.id].map(str).find((x) => x !== undefined && ITEM.test(x));
	const boundCorr = typeof bound.corr === "string" && HEX12.test(bound.corr) ? bound.corr : undefined;
	if (bound.corr !== undefined && boundCorr === undefined) rejected++;
	const corr =
		boundCorr ?? (item ? corrOf(`item:${item}`) : rawDelivery !== undefined ? corrOfDelivery(rawDelivery) : null);
	return { cols: { thread, corr, delivery }, rejected };
}

function strings(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.map((x) => (typeof x === "string" ? x : str((x as { deliveryId?: unknown } | null)?.deliveryId)));
	return out.every((x) => x !== undefined) ? (out as string[]) : undefined;
}

/** A legacy value read as a field's: its length, its error class or its digests, per `via`. */
function viaValue(spec: FieldSpec, raw: unknown): unknown {
	switch (spec.via) {
		case "len":
			return Array.isArray(raw) ? raw.length : undefined;
		case "err":
			return raw === undefined || raw === null ? undefined : errClass(raw);
		case "corrs":
			return strings(raw)?.map(corrOf);
		default:
			return raw;
	}
}

/** The registry's fields read out of an existing call's data. Anything it does not name is left behind. */
export function projectLegacy(spec: EventSpec, input: Record<string, unknown>, known: Known): Projected {
	const data: Record<string, FieldValue> = {};
	let rejected = 0;
	for (const [name, f] of Object.entries(spec.fields)) {
		const raw = viaValue(f, input[f.from ?? name]);
		if (raw === undefined || raw === null) continue;
		const v = check(f.type, raw, known);
		if (v === BAD) rejected++;
		else data[name] = v;
	}
	return { data, rejected };
}

/** A typed call's fields, each checked against the registry: an unlisted field or a value of the wrong shape is dropped and counted. */
export function projectTyped(spec: EventSpec, input: Record<string, unknown>, known: Known): Projected {
	const data: Record<string, FieldValue> = {};
	let rejected = 0;
	for (const [name, raw] of Object.entries(input)) {
		const f = own(spec.fields, name);
		const v = f && raw !== undefined && raw !== null ? check(f.type, raw, known) : BAD;
		if (v === BAD) rejected += raw === undefined || raw === null ? 0 : 1;
		else data[name] = v;
	}
	return { data, rejected };
}
