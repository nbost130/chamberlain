/** Reading a question from the command line's JSON: its options, routing, evidence and the checks on them. */
import { alwaysUrgent, type Evidence, KINDS, type Option, type Question } from "./core/questions.ts";
import { expiresProblem, isExpired } from "./core/rulings-expiry.ts";

export const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const VIDEO = new Set([".mp4", ".webm", ".mov"]);

type Raw = Record<string, unknown>;

/** A text field, trimmed, or undefined when it is absent, null or empty. A value that is not text is refused. */
function optText(o: Raw, k: string): string | undefined {
	const v = o[k];
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string") throw Error(`ask: "${k}" must be a string`);
	return v.trim();
}

/** A text field that must be there. */
function reqText(o: Raw, k: string): string {
	const v = optText(o, k);
	if (v === undefined) throw Error(`ask: "${k}" is required`);
	return v;
}

/** `{}` unless `cond`, so an optional field is left off an item rather than set to undefined. */
const when = <T extends object>(cond: unknown, fields: T): Partial<T> => (cond ? fields : {});

/** Option `n`'s thread routing (its `route: "thread"` and the `relay` text the thread gets), or undefined for a steward option; a malformed one is refused. */
function parseRouting(opt: Raw | undefined, n: number): { route: "thread"; relay: string } | undefined {
	const route = opt?.route;
	if (route !== undefined && route !== null && route !== "thread" && route !== "steward")
		throw Error(`ask: option ${n} route must be "thread" or "steward"`);
	const rawRelay = opt?.relay;
	if (rawRelay !== undefined && rawRelay !== null && typeof rawRelay !== "string")
		throw Error(`ask: option ${n} relay must be a string`);
	const relay = typeof rawRelay === "string" ? rawRelay.trim() : "";
	if (route === "thread" && !relay)
		throw Error(`ask: option ${n} routes to the thread, so it needs relay text: the exact instruction the thread gets`);
	// relay text only ever applies to a thread-routed option, so a steward option keeps none.
	return route === "thread" ? { route, relay } : undefined;
}

/** Option number `i + 1`: a label, or an object with a label, an optional detail and an optional route. */
function parseOption(x: unknown, i: number): Option {
	const opt = typeof x === "object" && x !== null ? (x as Raw) : undefined;
	const label = typeof x === "string" ? x : opt?.label;
	if (typeof label !== "string" || !label.trim()) throw Error(`ask: option ${i + 1} needs a label`);
	const detail = typeof opt?.detail === "string" ? opt.detail.trim() : undefined;
	const routing = parseRouting(opt, i + 1);
	return {
		label: label.trim().replace(/\s*\(Recommended\)\s*$/i, ""),
		...when(detail, { detail }),
		...when(routing, { ...routing }),
	};
}

/** The options, two to nine of them (none are needed for a secret). */
function parseOptions(o: Raw, secret: boolean): Option[] {
	const options = (Array.isArray(o.options) ? o.options : []).map(parseOption);
	if (!secret && options.length < 2) throw Error("ask: give at least two options");
	if (options.length > 9) throw Error("ask: at most nine options (keys 1-9)");
	return options;
}

/** The preselected option's index from 0, or undefined when none is given. */
function parseRecommended(o: Raw, count: number): number | undefined {
	const r = o.recommended;
	if (r === undefined || r === null) return undefined;
	if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= count)
		throw Error("ask: recommended must be an option index from 0");
	return r;
}

/** Evidence entry number `i + 1`: an image or video with a path, or a link with an http(s) url. */
function parseEvidenceItem(x: unknown, i: number): Evidence {
	const e = x as Evidence;
	if (!["image", "video", "link"].includes(e?.type))
		throw Error(`ask: evidence ${i + 1} needs type image, video or link`);
	if (e.type === "link") {
		if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url))
			throw Error(`ask: evidence ${i + 1} needs an http(s) url`);
	} else if (typeof e.path !== "string" || !e.path) throw Error(`ask: evidence ${i + 1} needs a path`);
	return {
		type: e.type,
		...when(e.path, { path: e.path }),
		...when(e.url, { url: e.url }),
		...when(e.caption, { caption: String(e.caption) }),
	};
}

/** A time-bound proposed ruling needs the ruling, a real date, and a date that is not past. */
function checkProposedExpiry(proposedRuling: string | undefined, proposedExpires: string | undefined): void {
	if (!proposedExpires) return;
	if (!proposedRuling) throw Error("ask: proposedExpires needs a proposedRuling");
	const problem = expiresProblem(proposedExpires);
	if (problem) throw Error(`ask: proposedExpires ${problem}`);
	if (isExpired({ expires: proposedExpires })) throw Error("ask: proposedExpires is already past");
}

/** An option routed to the thread needs the item's threadId, and a secret never routes to a thread. */
function checkThreadRouting(o: Raw, options: Option[], secret: boolean): void {
	const toThread = options.some((x) => x.route === "thread");
	if (toThread && !optText(o, "threadId")) throw Error("ask: an option routed to the thread needs the item's threadId");
	if (secret && toThread)
		throw Error("ask: a secret is never answered on the page, so none of its options can route to the thread");
}

/**
 * Whether `urgent: false` stays on the item. An approval or a secret never waits: the demotion is ignored, said through `warn`, and the
 * question goes out urgent.
 */
function keepsDemotion(o: Raw, secret: boolean, tag: string | undefined, warn: (line: string) => void): boolean {
	if (o.urgent !== false) return false;
	if (!alwaysUrgent({ secret, ...(tag ? { tag } : {}) })) return true;
	warn(
		`ask: "urgent": false ignored: ${secret || /secret/i.test(tag ?? "") ? "a secret" : "an approval"} is always urgent, so it is filed and posted as urgent`,
	);
	return false;
}

/**
 * A checked item from the Steward's JSON, or the first thing wrong with it. `warn` hears what was changed rather than
 * refused: an `urgent: false` on an approval or a secret, which is ignored.
 */
export function parseAsk(
	raw: unknown,
	id: string,
	createdAt = new Date().toISOString(),
	warn: (line: string) => void = (l) => console.error(l),
): Question {
	const o = raw as Raw;
	if (!o || typeof o !== "object") throw Error("ask: expected a JSON object");
	const kind = reqText(o, "kind") as Question["kind"];
	if (!KINDS.includes(kind)) throw Error(`ask: kind must be one of ${KINDS.join(", ")}`);
	const secret = o.secret === true;
	const options = parseOptions(o, secret);
	const recommended = parseRecommended(o, options.length);
	const evidence = (Array.isArray(o.evidence) ? o.evidence : []).map(parseEvidenceItem);
	const proposedRuling = optText(o, "proposedRuling");
	const proposedExpires = optText(o, "proposedExpires");
	checkProposedExpiry(proposedRuling, proposedExpires);
	checkThreadRouting(o, options, secret);
	if (o.urgent !== undefined && typeof o.urgent !== "boolean") throw Error('ask: "urgent" must be true or false');
	const notSettled = optText(o, "notSettled");
	const tag = optText(o, "tag");
	const keepDemotion = keepsDemotion(o, secret, tag, warn);
	return {
		id,
		kind,
		title: reqText(o, "title"),
		context: optText(o, "context") ?? "",
		options,
		...when(recommended !== undefined, { recommended }),
		...when(proposedRuling, { proposedRuling }),
		...when(proposedExpires, { proposedExpires }),
		...when(evidence.length, { evidence }),
		thread: reqText(o, "thread"),
		server: reqText(o, "server"),
		...when(optText(o, "threadId"), { threadId: optText(o, "threadId") }),
		...when(optText(o, "blocks"), { blocks: optText(o, "blocks") }),
		...when(tag, { tag }),
		...when(secret, { secret: true }),
		...when(keepDemotion, { urgent: false as const }),
		...when(notSettled, { notSettled }),
		createdAt,
	};
}
