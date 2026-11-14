/**
 * What one idle thread sends to a classifier provider, and the redaction it passes through first.
 *
 * Exactly this leaves the machine, and only for the `jev` and `haiku` providers: the thread title (unless `send.title` is false), the
 * last `lastChars` characters of the last assistant message, and the last `previousChars` of the user message before it, labelled only
 * `human`, `agent` or `none`. Never thread ids, server names, file contents, tool output or the rest of the transcript.
 *
 * Every cut is followed by `.toWellFormed()`: a tail that splits an emoji leaves a lone surrogate, and Jev answers HTTP 400 "Request
 * contains invalid Unicode text". Redaction finds secrets in the whole text, so one that straddles the cut is still replaced.
 *
 * The redaction hook (`redact.command`) gets the state as JSON on stdin and must print the same shape on stdout within five seconds.
 * Anything else (a failure, a timeout, a different shape) throws, and the caller sends nothing: the thread is `unknown`.
 */
import { runPiped } from "../llm/spawn.ts";

type From = "human" | "agent" | "none";
export type SentState = {
	thread_title?: string;
	previous_message: { from: From; text: string };
	last_message: string;
};
export type SendConfig = { lastChars: number; previousChars: number; title: boolean };
export type RedactConfig = { builtin: boolean; command: string[] | null };
/** The thread as the classifier sees it: plain data from the idle-parents selection. */
export type ThreadText = {
	title: string;
	lastMessage: string;
	previous: { from: From; text: string };
};

const RULES: [RegExp, string][] = [
	[/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
	[/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<secret>"],
	[/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}\b/g, "<secret>"],
	[/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, "<secret>"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "<secret>"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
	[/\b(?:\+?1[ -.]?)?\(?\d{3}\)?[ -.]\d{3}[ -.]\d{4}\b/g, "<phone>"],
	[/(\/home|\/Users)\/[A-Za-z0-9._-]+/g, "~"],
];

type Span = { a: number; b: number; sub: string };
/** Pure: every match of every rule in the WHOLE text, earliest first (the longest where two start together), none overlapping. */
function spans(src: string): Span[] {
	const all: Span[] = [];
	for (const [re, sub] of RULES)
		for (const m of src.matchAll(re)) all.push({ a: m.index, b: m.index + m[0].length, sub });
	all.sort((x, y) => x.a - y.a || y.b - y.a - (x.b - x.a));
	const keep: Span[] = [];
	let end = -1;
	for (const sp of all)
		if (sp.a >= end) {
			keep.push(sp);
			end = sp.b;
		}
	return keep;
}

/**
 * Pure: the last `n` characters of `s` (trimmed), with the built-in redaction (emails, common API-key and token shapes, JWTs, phone
 * numbers, home-directory user names), and how many redactions it carries. Secrets are found in the WHOLE text, so a long token that
 * begins before the cut is still recognised; only matches that reach into the tail are replaced, and the tail is the source's own last
 * `n` characters (a replacement never pulls earlier text in). A match cut by the start of the tail is replaced whole. At most `n`
 * characters, well formed.
 */
export function redactTail(s: string, n: number): { text: string; hits: number } {
	if (n <= 0) return { text: "", hits: 0 };
	const src = s.trim();
	const start = Math.max(0, src.length - n);
	let out = "";
	let pos = start;
	let hits = 0;
	for (const sp of spans(src)) {
		if (sp.b <= start) continue;
		if (sp.a > pos) out += src.slice(pos, sp.a);
		out += sp.sub;
		hits++;
		pos = Math.max(pos, sp.b);
	}
	out += src.slice(pos);
	if (out.length > n) out = out.slice(-n);
	return { text: out.toWellFormed(), hits };
}

/** Pure: the built-in redaction over a whole text, and its hit count. */
export const redactText = (s: string) => redactTail(s, Math.max(1, s.trim().length));

/** Pure: the last `n` characters of `s`, trimmed, never ending in a lone surrogate. */
export const tail = (s: string, n: number): string => (n <= 0 ? "" : s.trim().slice(-n).toWellFormed());

/**
 * Pure: the state one thread sends, with the redaction count and the number of characters it carries. `builtin: false` skips the
 * built-in redaction (the hook, if any, still runs, in `runRedactHook`).
 */
export function buildState(
	t: ThreadText,
	send: SendConfig,
	builtin: boolean,
): { state: SentState; redactions: number; sentChars: number } {
	let redactions = 0;
	const clean = (s: string, n: number) => {
		if (!builtin) return tail(s, n);
		const r = redactTail(s, n);
		redactions += r.hits;
		return r.text;
	};
	const state: SentState = {
		...(send.title ? { thread_title: clean(t.title, 200) } : {}),
		previous_message: {
			from: t.previous.from,
			text: t.previous.from === "none" ? "" : clean(t.previous.text, send.previousChars),
		},
		last_message: clean(t.lastMessage, send.lastChars),
	};
	return { state, redactions, sentChars: sentChars(state) };
}

export const sentChars = (s: SentState): number =>
	(s.thread_title?.length ?? 0) + s.previous_message.text.length + s.last_message.length;

const FROM: readonly string[] = ["human", "agent", "none"];
/** Pure: a hook's output, checked to be the same shape as what it was given (the label cannot change), or a throw. */
export function parseHookOutput(out: string, given: SentState): SentState {
	let o: unknown;
	try {
		o = JSON.parse(out);
	} catch {
		throw Error("the redaction hook printed something that is not JSON");
	}
	const bad = () => Error("the redaction hook printed JSON that is not the state it was given");
	if (!o || typeof o !== "object" || Array.isArray(o)) throw bad();
	const s = o as Record<string, unknown>;
	const keys = Object.keys(s).sort().join(",");
	if (keys !== Object.keys(given).sort().join(",")) throw bad();
	const prev = s.previous_message as Record<string, unknown> | null;
	if (
		typeof s.last_message !== "string" ||
		(given.thread_title !== undefined && typeof s.thread_title !== "string") ||
		!prev ||
		typeof prev !== "object" ||
		Object.keys(prev).sort().join(",") !== "from,text" ||
		typeof prev.text !== "string" ||
		!FROM.includes(prev.from as string) ||
		prev.from !== given.previous_message.from
	)
		throw bad();
	return {
		...(given.thread_title !== undefined ? { thread_title: (s.thread_title as string).toWellFormed() } : {}),
		previous_message: { from: given.previous_message.from, text: (prev.text as string).toWellFormed() },
		last_message: (s.last_message as string).toWellFormed(),
	};
}

export type HookRunner = (
	argv: string[],
	stdin: string,
	timeoutMs: number,
) => Promise<{ code: number | null; stdout: string }>;

const spawnHook: HookRunner = (argv, stdin, timeoutMs) => runPiped(argv, stdin, timeoutMs);

const REDACT_HOOK_MS = 5000;
/** The state after the operator's redaction hook. Fails closed: any failure throws, and nothing may be sent. */
export async function runRedactHook(
	command: string[],
	state: SentState,
	run: HookRunner = spawnHook,
	timeoutMs = REDACT_HOOK_MS,
): Promise<SentState> {
	let r: Awaited<ReturnType<HookRunner>>;
	try {
		r = await run(command, JSON.stringify(state), timeoutMs);
	} catch {
		throw Error("the redaction hook could not be run");
	}
	if (r.code !== 0)
		throw Error(r.code === null ? "the redaction hook timed out" : `the redaction hook exited ${r.code}`);
	return parseHookOutput(r.stdout, state);
}
