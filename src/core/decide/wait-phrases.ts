/**
 * Closings that wait on someone or something without a trailing question mark: "I'm holding until you send…",
 * "waiting for the Steward…", "I'll adapt once…", "No reply needed while…". Plain code; no model.
 */

/** What a wait-closing names as the thing still owed, when the pattern can say. */
export type WaitClosing = { awaiting: string };

const clipAwait = (s: string) =>
	s
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[,;:]+$/, "")
		.slice(0, 120);

const group = (m: RegExpMatchArray, i: number) => {
	const g = m[i];
	return typeof g === "string" ? clipAwait(g) : "";
};

/**
 * Patterns shaped like the 2026-11-15 Pilot B/C holds. Each capture group after the verb is the awaited thing;
 * the first match wins. Kept as a list so tests pin the real lines without growing looksLikeAsk's regex.
 */
const WAIT_PATTERNS: { re: RegExp; label: (m: RegExpMatchArray) => string }[] = [
	{ re: /\b(?:I'?m |I am )?holding until\s+(.+?)(?:[.!]|$)/i, label: (m) => group(m, 1) },
	{
		re: /\bwaiting (?:on|for)\s+((?:the )?(?:steward|coordinator|principal|operator|nathan|you)\b[^.\n!]{0,120}|[^.\n!]{2,120})/i,
		label: (m) => group(m, 1),
	},
	{ re: /\bI'?ll adapt once\s+(.+?)(?:[.!]|$)/i, label: (m) => group(m, 1) },
	{ re: /\bno reply needed while\s+(.+?)(?:[.!]|$)/i, label: (m) => group(m, 1) },
	{
		re: /\bafter the (steward|coordinator|principal|operator)\s+([^.\n!]{2,120})/i,
		label: (m) => clipAwait(`${group(m, 1)} ${group(m, 2)}`),
	},
];

/** Pure: the wait a closing line names, or undefined when it does not read as holding/waiting on someone. */
export function waitClosing(text: string): WaitClosing | undefined {
	const whole = text.trim().slice(-500);
	if (!whole) return undefined;
	for (const { re, label } of WAIT_PATTERNS) {
		const m = whole.match(re);
		if (m) {
			const awaiting = label(m);
			if (awaiting) return { awaiting };
		}
	}
	return undefined;
}

/** Pure: true when the closing is a wait on someone (Pilot B/C style), including when looksLikeAsk would have missed it. */
export const looksLikeWait = (text: string): boolean => waitClosing(text) !== undefined;
