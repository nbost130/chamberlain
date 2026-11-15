/** Bound → strip → redact → clip for alert fields. */
import type { AlertData } from "./alert-data.ts";
import type { DeskEvent } from "./alert-desk-config.ts";

const INPUT_BOUND = 64 * 1024;
const CLIPS = { source: 120, family: 120, title: 300, body: 1500 } as const;

const PATTERNS: [RegExp, string][] = [
	[/\bBearer\s+[A-Za-z0-9._-]+/gi, "bearer"],
	[/\beyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*/g, "jwt"],
	[/\bsk-[A-Za-z0-9]{20,}/g, "sk"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh"],
	[/\bxox[abpr]-[A-Za-z0-9-]+/g, "slack-token"],
	[/\bAKIA[A-Z0-9]{16}/g, "akia"],
	[/https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi, "slack-hook"],
	[/https?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi, "discord-hook"],
	[/https?:\/\/[^/\s]+:[^/\s]+@[^/\s]+/gi, "url-userinfo"],
	[/\b(?:pass(?:word)?|secret|token|api[_-]?key|auth|cookie|session)\s*[:=]\s*["']?[^\s"'&,;]+/gi, "kv"],
	[/"\s*(?:pass(?:word)?|secret|token|api[_-]?key|auth|cookie|session)"\s*:\s*"[^"]+"/gi, "json-kv"],
	[/\b[a-f0-9]{32,}\b/gi, "hex"],
	// Mixed base64url runs only (digit+letter), so a long `xxx…` pad does not steal a JWT/sk that follows.
	[/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "entropy"],
];

export function boundInput(s: string): string {
	if (s.length <= INPUT_BOUND) return s;
	return `${s.slice(0, INPUT_BOUND - 256)}…[cut]`;
}

function appendSurrogate(s: string, i: number, out: string): { out: string; skip: number } {
	const c = s.charCodeAt(i);
	const hi = s.at(i);
	const lo = s.at(i + 1);
	if (c >= 0xd800 && c <= 0xdbff) {
		const n = s.charCodeAt(i + 1);
		if (n >= 0xdc00 && n <= 0xdfff && hi !== undefined && lo !== undefined) return { out: out + hi + lo, skip: 1 };
		return { out, skip: 0 };
	}
	if (c >= 0xdc00 && c <= 0xdfff) return { out, skip: 0 };
	return { out: "", skip: -1 };
}

/** Strip C0/C1 (body keeps \n \t), Unicode format chars, and lone surrogates. */
function stripControls(s: string, keepNlTab: boolean): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const ch = s.at(i);
		if (ch === undefined) continue;
		if (keepNlTab && (c === 9 || c === 10)) {
			out += ch;
			continue;
		}
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
		const sur = appendSurrogate(s, i, out);
		if (sur.skip >= 0) {
			out = sur.out;
			i += sur.skip;
			continue;
		}
		if (!/\p{Cf}/u.test(ch)) out += ch;
	}
	return out;
}

export function redactSecrets(s: string): string {
	let out = s;
	for (const [re, kind] of PATTERNS) out = out.replace(re, `[redacted:${kind}]`);
	return out;
}

function clipField(s: string, n: number): string {
	if (s.length <= n) return s;
	let cut = s.slice(0, n);
	const open = cut.lastIndexOf("[redacted:");
	if (open >= 0 && cut.indexOf("]", open) < 0) cut = cut.slice(0, open);
	return cut;
}

export function prepareField(s: string, clip: number, body: boolean): string {
	return clipField(redactSecrets(stripControls(boundInput(s), body)), clip);
}

export function prepareEvent(e: DeskEvent, times: { firstSeen: string; lastSeen: string; folded: number }): AlertData {
	return {
		source: prepareField(e.source, CLIPS.source, false),
		family: prepareField(e.family, CLIPS.family, false),
		title: prepareField(e.title, CLIPS.title, false),
		body: prepareField(e.body, CLIPS.body, true),
		severity: e.severity,
		firstSeen: times.firstSeen,
		lastSeen: times.lastSeen,
		folded: times.folded,
	};
}
