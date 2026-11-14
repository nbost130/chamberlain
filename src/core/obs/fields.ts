/**
 * The opaque field types of the event registry (docs/OBSERVABILITY.md section 3), and the two functions that turn a thing with text in it into
 * something without: `errClass` (an error, as a class name) and `corrOf` (an id, as a 12-hex digest).
 *
 * There is no string type here and no note field: a value is an identifier of a fixed shape, a member of a fixed set, a number or a flag. A thread
 * title, a path, a URL, an error message and a prompt have no shape that passes, so none can be stored.
 */
import { createHash } from "node:crypto";

/** What `check` returns for a value its type does not accept. */
export const BAD = Symbol("bad field value");

export type FieldType =
	| { kind: "uuid" | "hex12" | "item" | "model" | "int" | "ms" | "bool" }
	| { kind: "enum"; values: readonly string[] }
	| { kind: "known"; set: string }
	| { kind: "list"; of: FieldType; max: number };

type Scalar = string | number | boolean;
export type FieldValue = Scalar | Scalar[];

/** The values a `known` set accepts, filled at run time from the operator's own config (the server names, the receiver names). */
export type Known = ReadonlyMap<string, ReadonlySet<string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX12 = /^[0-9a-f]{12}$/;
const ITEM = /^Q-[a-z0-9]{4,16}$/;
/**
 * A model's name: short segments of letters and digits joined by dots, colons, dashes or underscores (`claude-opus-5-5`, `gpt-6.1-sol`). No slash,
 * and no run of more than 12 characters without a separator, so a 32-character key or a hex digest is not a model name.
 */
const MODEL = /^[a-z][a-z0-9]{0,11}(?:[._:-][a-z0-9]{1,12}){0,6}$/i;

/** `o[k]` when `k` is the object's own key: a registry lookup by a name from outside must never reach `constructor` or `__proto__`. */
export const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
	Object.hasOwn(o, k) ? o[k] : undefined;

/** Whether `v` is a UUID. */
export const isUuid = (v: string): boolean => UUID.test(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

const TEST: Record<string, (v: unknown) => boolean> = {
	uuid: (v) => typeof v === "string" && UUID.test(v),
	hex12: (v) => typeof v === "string" && HEX12.test(v),
	item: (v) => typeof v === "string" && ITEM.test(v),
	model: (v) => typeof v === "string" && MODEL.test(v),
	int: isInt,
	ms: (v) => isInt(v) && v >= 0,
	bool: (v) => typeof v === "boolean",
};

/** The value when `type` accepts it, else BAD. */
export function check(type: FieldType, v: unknown, known: Known): FieldValue | typeof BAD {
	switch (type.kind) {
		case "enum":
			return typeof v === "string" && type.values.includes(v) ? v : BAD;
		case "known":
			return typeof v === "string" && known.get(type.set)?.has(v) ? v : BAD;
		case "list":
			return checkList(type, v, known);
		default:
			return own(TEST, type.kind)?.(v) ? (v as Scalar) : BAD;
	}
}

function checkList(type: Extract<FieldType, { kind: "list" }>, v: unknown, known: Known): Scalar[] | typeof BAD {
	if (!Array.isArray(v) || v.length > type.max) return BAD;
	const out: Scalar[] = [];
	for (const x of v) {
		const c = check(type.of, x, known);
		if (c === BAD || Array.isArray(c)) return BAD;
		out.push(c);
	}
	return out;
}

/** The constructors the registry is written with. */
export const T = {
	uuid: { kind: "uuid" },
	hex12: { kind: "hex12" },
	item: { kind: "item" },
	model: { kind: "model" },
	int: { kind: "int" },
	ms: { kind: "ms" },
	bool: { kind: "bool" },
	enm: (...values: string[]): FieldType => ({ kind: "enum", values }),
	known: (set: string): FieldType => ({ kind: "known", set }),
	list: (of: FieldType, max = 100): FieldType => ({ kind: "list", of, max }),
} as const satisfies Record<string, FieldType | ((...a: never[]) => FieldType)>;

// ---- errors, as a class ----------------------------------------------------------------------------

export const ERR_CLASSES = [
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EACCES",
	"ENOENT",
	"EPIPE",
	"timeout",
	"abort",
	"http-4xx",
	"http-5xx",
	"busy",
	"parse",
	"type",
	"other",
] as const;
export type ErrClass = (typeof ERR_CLASSES)[number];
export const ERR_TYPE: FieldType = { kind: "enum", values: ERR_CLASSES };

const ERR_RULES: readonly [ErrClass, RegExp][] = [
	["ECONNREFUSED", /ECONNREFUSED|connection refused|unable to connect/i],
	["ECONNRESET", /ECONNRESET|connection reset|socket hang up|closed unexpectedly|connection closed/i],
	["ETIMEDOUT", /ETIMEDOUT/],
	["timeout", /time[ds]? ?out|deadline/i],
	["ENOTFOUND", /ENOTFOUND|EAI_AGAIN|getaddrinfo/i],
	["EACCES", /EACCES|EPERM|permission denied/i],
	["ENOENT", /ENOENT|no such file/i],
	["EPIPE", /EPIPE|broken pipe/],
	["abort", /AbortError|aborted/i],
	["busy", /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i],
	["http-4xx", /\b(?:HTTP|status|code)\D{0,3}4\d\d\b/i],
	["http-5xx", /\b(?:HTTP|status|code)\D{0,3}5\d\d\b/i],
	["parse", /SyntaxError|JSON|Unexpected token/i],
	["type", /TypeError|ReferenceError/],
];

/** What an error is made of, searched for its class: the code, the name, then the message. The text itself is never kept. */
function errorText(e: unknown): string {
	if (typeof e === "string") return e;
	if (e instanceof Error) return `${(e as { code?: unknown }).code ?? ""} ${e.name} ${e.message}`;
	return typeof e === "object" && e !== null ? `${(e as { code?: unknown }).code ?? ""}` : "";
}

/** An error as one of a fixed set of class names, never its message: ECONNREFUSED, timeout, http-4xx, and so on; anything else is `other`. */
export function errClass(e: unknown): ErrClass {
	const text = errorText(e);
	return ERR_RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
}

// ---- ids, as a digest ----------------------------------------------------------------------------------

/** The 12-hex digest of an id the code already has (a delivery id, `item:<id>`): joins rows without storing the id. */
export const corrOf = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
