/**
 * Ask the principal one question through the decision queue. It records the question in the database (~/.local/state/chamberlain/chamberlain.db), copies its
 * evidence under ~/.local/state/chamberlain/evidence/<id>/, and shows it where the operator reads through the adapter's `post`
 * (for T3, the pinned Decisions thread, never a card), so the question shows in both places until one of them answers it.
 *
 *   bun src/ask.ts '<json>'        or   bun src/ask.ts - < item.json
 *
 * JSON: {kind: "only-you"|"product"|"ruling"|"idea", title, context, options: [{label, detail, route?: "thread"|"steward",
 *        relay?}], recommended?: index, proposedRuling?, proposedExpires?, evidence?: [{type: "image"|"video"|"link", path|url, caption}],
 *        thread, server, threadId?, blocks?, tag?, secret?, urgent?, notSettled?}
 * `urgent: false` marks a question that can wait: it is recorded and listed on the queue page below the urgent ones, but
 * nothing is posted where the operator reads, so no notification goes out. Leave it off and the question is urgent.
 * An approval (tag "Approval") or a secret (`secret: true` or tag "Secret") is ALWAYS urgent: `urgent: false` on one is
 * ignored, with a note on stderr, and the question is filed and posted as urgent.
 * Before it records anything, ask.ts looks the question up in what the principal already settled (answered questions,
 * rulings in force or retired, the Steward's decision log; src/core/settled.ts). A match is refused with exit 2 and one line
 * per match saying what it matched on: act on that answer instead. If it is truly a different question, add
 * `"notSettled": "<why>"`; the reason is stored on the question.
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
import { copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { homeAdapter } from "./adapters/index.ts";
import { IMAGE, parseAsk, VIDEO } from "./ask-parse.ts";
import type { Adapter, PostResult } from "./core/adapter.ts";
import { readViewKey } from "./core/capability.ts";
import { CONF, STATE } from "./core/config.ts";
import { defaultStore } from "./core/default-store.ts";
import { cfg } from "./core/layout.ts";
import { startup } from "./core/migrate.ts";
import { askQuestion, type Evidence, evidenceRoot, isUrgent, newItemId, type Question } from "./core/questions.ts";
import { findSettled, refusalLines } from "./core/settled.ts";
import type { Store } from "./core/store.ts";

export { newItemId };

/** One piece of evidence: a link as it is, a file copied into `dir` under a safe, unique name (`used` holds the names taken) with its path rewritten to that name. */
function stageOne(e: Evidence, i: number, dir: string, used: Set<string>): Evidence {
	if (e.type === "link") return e;
	if (e.path === undefined) throw Error(`ask: evidence ${i + 1} needs a path`);
	const src = e.path.replace(/^~(?=\/)/, process.env.HOME ?? "");
	if (!existsSync(src) || !lstatSync(src).isFile())
		throw Error(`ask: evidence ${i + 1} is not a regular file: ${e.path}`);
	const ext = extname(src).toLowerCase();
	if (!(e.type === "image" ? IMAGE : VIDEO).has(ext))
		throw Error(`ask: evidence ${i + 1} must be ${e.type === "image" ? "png, jpg, gif or webp" : "mp4, webm or mov"}`);
	let name =
		basename(src)
			.replace(/[^A-Za-z0-9._-]/g, "_")
			.replace(/^\.+/, "") || `file${ext}`;
	if (used.has(name)) name = `${i + 1}-${name}`;
	used.add(name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	copyFileSync(src, `${dir}/${name}`);
	return { ...e, path: name };
}

/**
 * Copies each image or video into the item's own evidence folder and rewrites its path to the bare file name, which
 * is all the page serves. A file that is missing, not a regular file, or not an image or video fails the ask.
 */
export function stageEvidence(item: Question, state = STATE): Question {
	if (!item.evidence?.length) return item;
	const dir = `${evidenceRoot(state)}/${item.id}`;
	const used = new Set<string>();
	return { ...item, evidence: item.evidence.map((e, i) => stageOne(e, i, dir, used)) };
}

/** The queue page's base URL from web.json, or undefined when the page is not configured (then no inline view). */
export function queueBase(conf = CONF): string | undefined {
	try {
		const w = (cfg(conf, "web") ?? {}) as {
			host?: string;
			port?: number;
			publicBase?: string;
		};
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

/** Refuses (exit 2, one line per match) a question the principal has already settled. */
function refuseIfSettled(store: Store, q: Question): void {
	const { matches, skipped } = findSettled(store, { title: q.title, context: q.context, thread: q.thread });
	for (const k of skipped) console.error(`ask.ts: the settled check could not read ${k}`);
	if (!matches.length) return;
	console.error(
		refusalLines("ask.ts", matches, 'add "notSettled": "<why this is a different question>" to the JSON').join("\n"),
	);
	process.exit(2);
}

/** The view key for the view's script address, or undefined, with the reason on stderr: a key that cannot be read (a wrong mode) or is missing never makes a link that would not work. */
function viewKeyOrNotice(): string | undefined {
	let key: string | undefined;
	try {
		key = readViewKey(CONF);
	} catch (e) {
		console.error(
			`the view key could not be read (${String((e as Error).message).slice(0, 120)}); posting a notice instead of the view`,
		);
	}
	if (!key)
		console.error(
			"the page has no view key yet: start the page (chamberlain web); posting a notice instead of the view",
		);
	return key;
}

/** The queue page's address and key for the card's inline view, each undefined unless the page answers now and has a key. */
async function inlineView(): Promise<{ queueUrl: string | undefined; capability: string | undefined }> {
	const base = queueBase();
	const up = base !== undefined && (await queueUp(base));
	// The view's script address carries the VIEW key, never the page's key (a post is copied into the thread). The page makes it when it
	// starts, so a page that answers has one.
	const key = up ? viewKeyOrNotice() : undefined;
	const inline = up && key !== undefined;
	return { queueUrl: inline ? base : undefined, capability: inline ? key : undefined };
}

/**
 * Shows a question where the operator reads, through the adapter: the pinned view when the page answers and has a key, else a one-line
 * notice. The daemon uses it too, when a snoozed urgent question returns (src/core/snooze.ts).
 */
export async function postQuestion(item: Question, adapter: Adapter): Promise<PostResult> {
	return adapter.post(item, await inlineView());
}

/** Posts the question where the operator reads and says where it went. */
async function postAndReport(item: Question): Promise<void> {
	const { adapter } = homeAdapter({ conf: CONF, state: STATE });
	const card = await postQuestion(item, adapter);
	if (!card.ok) {
		console.error(`${item.id} is on the queue page, but the question did not post: ${card.detail}`);
		process.exit(1);
	}
	console.log(
		`${item.id} (on the queue page; ${card.where === "view" ? "shown where the operator reads" : "the page did not answer, so the operator got a one-line notice"})`,
	);
	// The index counts from 0; echo the label so a 1-based slip is seen at once (2026-11-11: five questions preselected the wrong option).
	if (item.recommended !== undefined)
		console.log(`recommended (preselected): ${item.options[item.recommended]?.label}`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const arg = argv[0];
	if (!arg) {
		console.error("usage: ask.ts '<json>' | ask.ts - < item.json");
		process.exit(2);
	}
	const raw = JSON.parse(arg === "-" ? await Bun.stdin.text() : arg);
	const parsed = parseAsk(raw, newItemId());
	const store = defaultStore();
	if (!parsed.notSettled) refuseIfSettled(store, parsed);
	const item = stageEvidence(parsed);
	askQuestion(store, item, Date.parse(item.createdAt));
	if (item.secret) {
		console.log(`${item.id} (secret: on the page as a link to its thread; no card)`);
		return;
	}
	// A non-urgent question is on the page and nowhere else: the post is the only notification a new question sends.
	if (!isUrgent(item)) {
		console.log(`${item.id} (on the queue page, not urgent: no notification sent)`);
		return;
	}
	await postAndReport(item);
}

if (import.meta.main)
	main().catch((e) => {
		console.error(String(e instanceof Error ? e.message : e));
		process.exit(1);
	});
