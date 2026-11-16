/**
 * Alert text as one printable-ASCII, angle-bracket-free JSON line inside a fixed enclosure.
 * Field pipeline: bound → strip → redact → clip, before anything is stored or rendered.
 */
export const ALERT_DATA_SCHEMA = {
	source: "string",
	family: "string",
	title: "string",
	body: "string",
	severity: "string",
	firstSeen: "string",
	lastSeen: "string",
	folded: "number",
} as const;

export type AlertData = {
	source: string;
	family: string;
	title: string;
	body: string;
	severity: string;
	firstSeen: string;
	lastSeen: string;
	folded: number;
};

const SCHEMA_KEYS = Object.keys(ALERT_DATA_SCHEMA) as (keyof typeof ALERT_DATA_SCHEMA)[];
const OPEN = /^<<alert-data v1 len=(\d{1,6})>>$/;
const CLOSE = "<<end alert-data>>";

/** Escape every code point outside 0x20–0x7E, and every `<` / `>`, as `\uXXXX`. */
function escapeAlertJson(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c > 0x7e || c === 0x3c || c === 0x3e) out += `\\u${c.toString(16).padStart(4, "0")}`;
		else out += s[i];
	}
	return out;
}

export function encodeAlertData(o: AlertData): string {
	const parts = SCHEMA_KEYS.map((k) => {
		const v = o[k];
		const raw = typeof v === "string" ? `"${escapeAlertJson(v)}"` : String(v);
		return `"${k}":${raw}`;
	});
	const payload = `{${parts.join(",")}}`;
	return `<<alert-data v1 len=${payload.length}>>\n${payload}\n${CLOSE}`;
}

function typesOk(o: Record<string, unknown>): o is AlertData {
	for (const k of SCHEMA_KEYS) {
		const want = ALERT_DATA_SCHEMA[k];
		if (!(k in o) || typeof o[k] !== want) return false;
	}
	return Object.keys(o).length === SCHEMA_KEYS.length;
}

export function parseAlertData(text: string): AlertData {
	const lines = text.split("\n");
	const opener = lines[0];
	const payload = lines[1];
	const closer = lines[2];
	if (lines.length !== 3 || opener === undefined || payload === undefined || closer === undefined)
		throw new Error("alert-data: need opener, payload, closer");
	const m = OPEN.exec(opener);
	if (!m) throw new Error("alert-data: bad opener");
	const len = Number(m[1]);
	if (payload.length !== len) throw new Error("alert-data: len mismatch");
	if (!/^[\x20-\x7e]*$/.test(payload) || payload.includes("<") || payload.includes(">"))
		throw new Error("alert-data: alphabet");
	if (closer !== CLOSE) throw new Error("alert-data: bad closer");
	const o = JSON.parse(payload) as Record<string, unknown>;
	if (!typesOk(o)) throw new Error("alert-data: schema");
	return o;
}

export function parseWake(message: string): { enclosures: AlertData[]; trustedLines: string[] } {
	const lines = message.split("\n");
	const enclosures: AlertData[] = [];
	const trustedLines: string[] = [];
	for (let i = 0; i < lines.length; ) {
		const line = lines[i];
		if (line === undefined) break;
		if (OPEN.test(line)) {
			enclosures.push(parseAlertData(lines.slice(i, i + 3).join("\n")));
			i += 3;
		} else {
			trustedLines.push(line);
			i++;
		}
	}
	return { enclosures, trustedLines };
}
