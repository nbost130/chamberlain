/** Reading a question from the command line's JSON: its options, routing, evidence and the checks on them. */
import { alwaysUrgent, type Evidence, KINDS, type Option, type Question } from "./core/items/questions.ts";
import { runIdsIn } from "./core/items/settled-text.ts";
import { expiresProblem, isExpired } from "./core/ops/rulings-expiry.ts";
import { SAFE_REPO } from "./core/overhead/config-names.ts";

export const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const VIDEO = new Set([".mp4", ".webm", ".mov"]);

type Raw = Record<string, unknown>;
const MAX_DETAILS = 4000;
const MAX_CONTEXT_BULLET = 160;

function parseDetails(o: Raw, secret: boolean): string | undefined {
	const canonical = Object.hasOwn(o, "details");
	const alias = Object.hasOwn(o, "technicalRef");
	if (canonical && alias) throw Error('ask: give either "details" or "technicalRef", not both');
	if (!canonical && !alias) return undefined;
	if (secret) throw Error("ask: a secret question cannot have details");
	const field = canonical ? "details" : "technicalRef";
	const raw = o[field];
	if (raw == null) return undefined;
	if (typeof raw !== "string") throw Error(`ask: "${field}" must be a string`);
	if (raw.length > MAX_DETAILS) throw Error(`ask: "${field}" must be at most ${MAX_DETAILS} characters`);
	return raw.trim() ? raw : undefined;
}

/** Advisory only. Static warnings keep the input out of stderr. */
export function warnReadability(q: Question, warn: (line: string) => void): void {
	if (q.secret) return;
	for (const field of ["title", "context"] as const) {
		const value = q[field];
		const hasSha = [...value.matchAll(/\b[0-9a-f]{12,}\b/gi)].some(([hex]) => /\d/.test(hex) && /[a-f]/i.test(hex));
		if (hasSha || runIdsIn(value).length) warn(`ask: ${field} contains a raw run ID or long SHA. Move it to details.`);
	}
	const bullets = q.context
		.split(/\r?\n/)
		.map((line) => /^\s*(?:- |• )(.*)$/.exec(line)?.[1])
		.filter((line) => line !== undefined);
	if (bullets.length > 4)
		warn("ask: context has more than 4 bullets. Move technical references to details and keep 3 or 4 short bullets.");
	if (bullets.some((line) => line.length > MAX_CONTEXT_BULLET))
		warn(
			`ask: a context bullet is longer than ${MAX_CONTEXT_BULLET} characters. Move technical references to details and shorten the bullet.`,
		);
}

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

/** The relay text an option gets when the item-wide `route: "thread"` sends it to the thread and it names no relay of its own. */
export const DEFAULT_RELAY = "Carry on with this choice.";

/** The item-wide route every option without its own takes: "thread", or undefined for the default, the Steward. */
function parseItemRoute(o: Raw): "thread" | undefined {
	const r = o.route;
	if (r === undefined || r === null || r === "steward") return undefined;
	if (r !== "thread") throw Error('ask: "route" must be "thread" or "steward"');
	return r;
}

/**
 * Option `n`'s thread routing (its `route: "thread"` and the `relay` text the thread gets), or undefined for a steward option; a malformed
 * one is refused. An option with no route of its own takes the item's (`fallback`), and then its relay text defaults to DEFAULT_RELAY.
 */
function parseRouting(
	opt: Raw | undefined,
	n: number,
	fallback?: "thread",
): { route: "thread"; relay: string } | undefined {
	const own = opt?.route ?? undefined;
	if (own !== undefined && own !== "thread" && own !== "steward")
		throw Error(`ask: option ${n} route must be "thread" or "steward"`);
	const rawRelay = opt?.relay;
	if (rawRelay !== undefined && rawRelay !== null && typeof rawRelay !== "string")
		throw Error(`ask: option ${n} relay must be a string`);
	const relay = typeof rawRelay === "string" ? rawRelay.trim() : "";
	// No route of its own: the item's, with the default relay text when it gives none.
	if (own === undefined && fallback) return { route: fallback, relay: relay || DEFAULT_RELAY };
	if (own === "thread" && !relay)
		throw Error(`ask: option ${n} routes to the thread, so it needs relay text: the exact instruction the thread gets`);
	// relay text only ever applies to a thread-routed option, so a steward option keeps none.
	return own === "thread" ? { route: own, relay } : undefined;
}

/** Option number `i + 1`: a label, or an object with a label, an optional detail and an optional route. */
function parseOption(x: unknown, i: number, fallback?: "thread"): Option {
	const opt = typeof x === "object" && x !== null ? (x as Raw) : undefined;
	const label = typeof x === "string" ? x : opt?.label;
	if (typeof label !== "string" || !label.trim()) throw Error(`ask: option ${i + 1} needs a label`);
	const detail = typeof opt?.detail === "string" ? opt.detail.trim() : undefined;
	const routing = parseRouting(opt, i + 1, fallback);
	return {
		label: label.trim().replace(/\s*\(Recommended\)\s*$/i, ""),
		...when(detail, { detail }),
		...when(routing, { ...routing }),
	};
}

/** True when this ask is a secret: `secret: true` or the tag "Secret". */
function isSecretAsk(secret: boolean, tag: string | undefined): boolean {
	return secret || /^\s*secret\s*$/i.test(tag ?? "");
}

/** The options, two to nine of them (a secret must have none). */
function parseOptions(o: Raw, secret: boolean): Option[] {
	const fallback = parseItemRoute(o);
	const options = (Array.isArray(o.options) ? o.options : []).map((x, i) => parseOption(x, i, fallback));
	if (!secret && options.length < 2) throw Error("ask: give at least two options");
	if (options.length > 9) throw Error("ask: at most nine options (keys 1-9)");
	return options;
}

/**
 * A secret that cannot be completed is refused before anything is recorded: options are never shown or answered on a
 * secret, and a secret is entered only in the thread named by `threadId`. `secret` is the one classification used for
 * validation and the filed item (`secret: true` or the tag "Secret").
 */
function checkSecretAsk(o: Raw, options: Option[], secret: boolean): void {
	if (!secret) return;
	if (options.length > 0)
		throw Error(
			"ask: a secret question cannot have options; file a non-secret choice question first, then a secret request in its thread",
		);
	if (!optText(o, "threadId"))
		throw Error("ask: a secret question needs a threadId; a secret is entered in its own thread");
}

/** The preselected option's index from 0, or undefined when none is given. */
function parseRecommended(o: Raw, count: number): number | undefined {
	const r = o.recommended;
	if (r === undefined || r === null) return undefined;
	if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= count)
		throw Error("ask: recommended must be an option index from 0");
	return r;
}

function parseRepo(repo: unknown): string | undefined {
	if (repo === undefined) return undefined;
	if (typeof repo !== "string" || !SAFE_REPO.test(repo)) throw Error('ask: "repo" must be an owner/name repository');
	return repo;
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

/** An option routed to the thread needs the item's threadId, and a secret (`secret: true`, or a tag naming a secret) never routes to a thread. */
function checkThreadRouting(o: Raw, options: Option[], flagged: boolean): void {
	const secret = flagged || /secret/i.test(optText(o, "tag") ?? "");
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
	const tag = optText(o, "tag");
	// One classification for validation and the filed item: `secret: true` or the tag "Secret".
	const secret = isSecretAsk(o.secret === true, tag);
	const details = parseDetails(o, secret);
	const options = parseOptions(o, secret);
	const recommended = parseRecommended(o, options.length);
	const evidence = (Array.isArray(o.evidence) ? o.evidence : []).map(parseEvidenceItem);
	const proposedRuling = optText(o, "proposedRuling");
	const proposedExpires = optText(o, "proposedExpires");
	checkProposedExpiry(proposedRuling, proposedExpires);
	checkSecretAsk(o, options, secret);
	checkThreadRouting(o, options, secret);
	if (o.urgent !== undefined && typeof o.urgent !== "boolean") throw Error('ask: "urgent" must be true or false');
	const notSettled = optText(o, "notSettled");
	const keepDemotion = keepsDemotion(o, secret, tag, warn);
	return {
		id,
		kind,
		title: reqText(o, "title"),
		context: optText(o, "context") ?? "",
		...when(details, { details }),
		options,
		...when(recommended !== undefined, { recommended }),
		...when(proposedRuling, { proposedRuling }),
		...when(proposedExpires, { proposedExpires }),
		...when(evidence.length, { evidence }),
		thread: reqText(o, "thread"),
		server: reqText(o, "server"),
		...when(optText(o, "threadId"), { threadId: optText(o, "threadId") }),
		...when(o.repo !== undefined, { repo: parseRepo(o.repo) }),
		...when(optText(o, "blocks"), { blocks: optText(o, "blocks") }),
		...when(tag, { tag }),
		...when(secret, { secret: true }),
		...when(keepDemotion, { urgent: false as const }),
		...when(notSettled, { notSettled }),
		createdAt,
	};
}
