/**
 * Ask the principal one question through the decision queue. It records the question in the database (~/.local/state/chamberlain/chamberlain.db), copies its
 * evidence under ~/.local/state/chamberlain/evidence/<id>/, and shows it where the operator reads through the adapter's `post`
 * (for T3, the pinned Decisions thread, never a card), so the question shows in both places until one of them answers it.
 *
 *   bun src/ask.ts '<json>'        or   bun src/ask.ts - < item.json
 *
 * JSON: {kind: "only-you"|"product"|"ruling"|"idea", title, context, options: [{label, detail, route?: "thread"|"steward",
 *        relay?}], recommended?: index, proposedRuling?, proposedExpires?, evidence?: [{type: "image"|"video"|"link", path|url, caption}],
 *        thread, server, threadId?, blocks?, tag?, secret?}
 * `proposedExpires` (an ISO date, or a date-time with a zone) makes the proposed ruling time-bound: if the principal saves it, it
 * drops out of every wake after that moment and the rulings page marks it expired. Give it whenever the ruling is about one run,
 * one launch or one week; leave it off only for a rule meant to stand.
 * Routing is per option and defaults to "steward". An option with `route: "thread"` and its `relay` text (the exact
 * instruction the thread gets) goes straight to `threadId` when the principal picks it with no note: use it for a simple
 * step the thread can carry out alone, like a product or design pick or leave for its own next step. Keep "steward" for
 * anything complex or needing oversight (a gate, a release, a "hold" or "no" that needs re-planning). A note from the
 * principal, or a thread send that fails, always comes to the Steward as an answer wake.
 * Lines of `context` that start with "- " render as bullets on the queue page and the Decisions view; write a few short ones.
 * Prints the item ID. A secret item posts no card: its value is entered in its own thread, never on a card or the page.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { CONF, STATE } from "./core/config.ts";
import { homeAdapter } from "./adapters/index.ts";
import { defaultStore } from "./core/default-store.ts";
import { startup } from "./core/migrate.ts";
import { expiresAt, isExpired } from "./core/rulings.ts";
import { askQuestion, evidenceRoot, KINDS, type Evidence, type Question, type Option } from "./core/questions.ts";

export const newItemId = () => `Q-${Date.now().toString(36).slice(-5)}${randomBytes(3).toString("hex").slice(0, 4)}`;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO = new Set([".mp4", ".webm", ".mov"]);

/** Pure: a checked item from the Steward's JSON, or the first thing wrong with it. */
export function parseAsk(raw: unknown, id: string, createdAt = new Date().toISOString()): Question {
	const o = raw as Record<string, unknown>;
	if (!o || typeof o !== "object") throw Error("ask: expected a JSON object");
	const str = (k: string, required = true) => {
		const v = o[k];
		if (v === undefined || v === null || v === "") { if (required) throw Error(`ask: "${k}" is required`); return undefined; }
		if (typeof v !== "string") throw Error(`ask: "${k}" must be a string`);
		return v.trim();
	};
	const kind = str("kind") as Question["kind"];
	if (!KINDS.includes(kind)) throw Error(`ask: kind must be one of ${KINDS.join(", ")}`);
	const secret = o.secret === true;
	const options = (Array.isArray(o.options) ? o.options : []).map((x, i): Option => {
		const label = typeof x === "string" ? x : (x as Option)?.label;
		if (typeof label !== "string" || !label.trim()) throw Error(`ask: option ${i + 1} needs a label`);
		const detail = typeof x === "object" && typeof (x as Option).detail === "string" ? (x as Option).detail!.trim() : undefined;
		const route = typeof x === "object" ? (x as Option).route : undefined;
		if (route !== undefined && route !== null && route !== "thread" && route !== "steward") throw Error(`ask: option ${i + 1} route must be "thread" or "steward"`);
		const rawRelay = typeof x === "object" ? (x as Option).relay : undefined;
		if (rawRelay !== undefined && rawRelay !== null && typeof rawRelay !== "string") throw Error(`ask: option ${i + 1} relay must be a string`);
		const relay = typeof rawRelay === "string" ? rawRelay.trim() : "";
		if (route === "thread" && !relay) throw Error(`ask: option ${i + 1} routes to the thread, so it needs relay text: the exact instruction the thread gets`);
		// relay text only ever applies to a thread-routed option, so a steward option keeps none.
		return { label: label.trim().replace(/\s*\(Recommended\)\s*$/i, ""), ...(detail ? { detail } : {}), ...(route === "thread" ? { route, relay } : {}) };
	});
	if (!secret && options.length < 2) throw Error("ask: give at least two options");
	if (options.length > 9) throw Error("ask: at most nine options (keys 1-9)");
	let recommended: number | undefined;
	if (o.recommended !== undefined && o.recommended !== null) {
		if (!Number.isInteger(o.recommended) || (o.recommended as number) < 0 || (o.recommended as number) >= options.length) throw Error("ask: recommended must be an option index from 0");
		recommended = o.recommended as number;
	}
	const evidence = (Array.isArray(o.evidence) ? o.evidence : []).map((x, i): Evidence => {
		const e = x as Evidence;
		if (!["image", "video", "link"].includes(e?.type)) throw Error(`ask: evidence ${i + 1} needs type image, video or link`);
		if (e.type === "link") { if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) throw Error(`ask: evidence ${i + 1} needs an http(s) url`); }
		else if (typeof e.path !== "string" || !e.path) throw Error(`ask: evidence ${i + 1} needs a path`);
		return { type: e.type, ...(e.path ? { path: e.path } : {}), ...(e.url ? { url: e.url } : {}), ...(e.caption ? { caption: String(e.caption) } : {}) };
	});
	const proposedRuling = str("proposedRuling", false);
	const proposedExpires = str("proposedExpires", false);
	if (proposedExpires) {
		if (!proposedRuling) throw Error("ask: proposedExpires needs a proposedRuling");
		if (Number.isNaN(expiresAt(proposedExpires))) throw Error("ask: proposedExpires must be an ISO date (2026-12-01) or date-time with a zone (2026-12-01T09:00:00Z)");
		if (isExpired({ expires: proposedExpires })) throw Error("ask: proposedExpires is already past");
	}
	if (options.some((x) => x.route === "thread") && !str("threadId", false)) throw Error("ask: an option routed to the thread needs the item's threadId");
	if (secret && options.some((x) => x.route === "thread")) throw Error("ask: a secret is never answered on the page, so none of its options can route to the thread");
	const item: Question = {
		id, kind, title: str("title")!, context: str("context", false) ?? "", options,
		...(recommended !== undefined ? { recommended } : {}),
		...(proposedRuling ? { proposedRuling } : {}),
		...(proposedExpires ? { proposedExpires } : {}),
		...(evidence.length ? { evidence } : {}),
		thread: str("thread")!, server: str("server")!,
		...(str("threadId", false) ? { threadId: str("threadId", false) } : {}),
		...(str("blocks", false) ? { blocks: str("blocks", false) } : {}),
		...(str("tag", false) ? { tag: str("tag", false) } : {}),
		...(secret ? { secret: true } : {}),
		createdAt,
	};
	return item;
}

/**
 * Copies each image or video into the item's own evidence folder and rewrites its path to the bare file name, which
 * is all the page serves. A file that is missing, not a regular file, or not an image or video fails the ask.
 */
export function stageEvidence(item: Question, state = STATE): Question {
	if (!item.evidence?.length) return item;
	const dir = `${evidenceRoot(state)}/${item.id}`;
	const used = new Set<string>();
	const evidence = item.evidence.map((e, i) => {
		if (e.type === "link") return e;
		const src = e.path!.replace(/^~(?=\/)/, process.env.HOME!);
		if (!existsSync(src) || !lstatSync(src).isFile()) throw Error(`ask: evidence ${i + 1} is not a regular file: ${e.path}`);
		const ext = extname(src).toLowerCase();
		if (!(e.type === "image" ? IMAGE : VIDEO).has(ext)) throw Error(`ask: evidence ${i + 1} must be ${e.type === "image" ? "png, jpg, gif or webp" : "mp4, webm or mov"}`);
		let name = basename(src).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || `file${ext}`;
		if (used.has(name)) name = `${i + 1}-${name}`;
		used.add(name);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		copyFileSync(src, `${dir}/${name}`);
		return { ...e, path: name };
	});
	return { ...item, evidence };
}

/** The queue page's base URL from web.json, or undefined when the page is not configured (then no inline view). */
export function queueBase(conf = CONF): string | undefined {
	try {
		const w = JSON.parse(readFileSync(`${conf}/web.json`, "utf8")) as { host?: string; port?: number; publicBase?: string };
		// An https base (tailscale serve) wins: T3 on the phone may load over its https relay, which blocks a plain-http script.
		if (typeof w.publicBase === "string" && /^https:\/\/[^/\s]+$/.test(w.publicBase)) return w.publicBase;
		if (!w.host || !w.port) return undefined;
		return `http://${w.host.includes(":") ? `[${w.host}]` : w.host}:${w.port}`;
	} catch {
		// EMPTY_CATCH_OK: no readable web.json means the page is not set up; the card is then sent without an inline view.
		return undefined;
	}
}

/** True when the queue server answers for inline.js now; otherwise the question goes out as a plain card. */
export async function queueUp(base: string, timeoutMs = 3000): Promise<boolean> {
	try {
		return (await fetch(`${base}/inline.js`, { signal: AbortSignal.timeout(timeoutMs) })).ok; // the server serves static files on GET only
	} catch {
		// EMPTY_CATCH_OK: an unreachable queue server just means the card goes out without the inline view.
		return false;
	}
}

async function main() {
	startup();
	const arg = process.argv[2];
	if (!arg) { console.error("usage: ask.ts '<json>' | ask.ts - < item.json"); process.exit(2); }
	const raw = JSON.parse(arg === "-" ? await Bun.stdin.text() : arg);
	const item = stageEvidence(parseAsk(raw, newItemId()));
	askQuestion(defaultStore(), item, Date.parse(item.createdAt));
	if (item.secret) { console.log(`${item.id} (secret: on the page as a link to its thread; no card)`); return; }
	const base = queueBase();
	const inline = base !== undefined && (await queueUp(base));
	const { adapter } = homeAdapter({ conf: CONF, state: STATE });
	const card = await adapter.post(item, { queueUrl: inline ? base : undefined });
	if (!card.ok) { console.error(`${item.id} is on the queue page, but the question did not post: ${card.detail}`); process.exit(1); }
	console.log(`${item.id} (on the queue page; ${card.where === "view" ? "shown where the operator reads" : "the page did not answer, so the operator got a one-line notice"})`);
	// The index counts from 0; echo the label so a 1-based slip is seen at once (2026-11-11: five questions preselected the wrong option).
	if (item.recommended !== undefined) console.log(`recommended (preselected): ${item.options[item.recommended]?.label}`);
}

if (import.meta.main) main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
