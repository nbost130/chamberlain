/**
 * A thread's note to the Steward: a report that goes through the outbox instead of a message straight into the Steward's thread. It is held
 * (hold.ts, kind "note"), so an idle Steward gets it at once and a busy one gets it in its next digest beside everything else held: a report
 * never queues a turn of its own behind the Steward's work. Each note is its own digest item and is never folded.
 */
import { createHash } from "node:crypto";
import { TRANSFER_WRAP_RESERVE_BYTES } from "../decide/hold-digest-batch.ts";
import { noteWakeText } from "../messages.ts";
import { exceedsEncodedCap, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { Store } from "../store/store.ts";
import { createOutbox } from "./deliver.ts";

/** The longest note body, in characters. A longer report belongs in a file the note names. */
export const NOTE_MAX_CHARS = 8000;
/** A heartbeat older than this means no daemon reads this state directory now, and a note written here would never be sent. */
export const DAEMON_STALE_MS = 5 * 60_000;
/** A heartbeat further ahead than this was written before the clock went back: it proves nothing about a daemon now. */
const HEARTBEAT_SKEW_MS = 60_000;
/** A thread id or server name: one token, no spaces, no line breaks, no fence characters. */
const TOKEN = /^[A-Za-z0-9._:%@/-]{1,200}$/;
/** The longest sender title. It sits outside the report's fence, so it is one short line. */
const FROM_MAX_CHARS = 120;

export type Note = { from: string; text: string; thread?: string; server?: string };
export type NoteResult =
	| { ok: true; deliveryId: string; status: "held" | "known" }
	| { ok: false; code: 2 | 3; error: string };

/** Pure: a note's delivery id, from what it says and who sent it, so the same note sent twice is one wake. */
export const noteDeliveryId = (n: Note): string =>
	`note:${createHash("sha1")
		.update([n.from, n.server ?? "", n.thread ?? "", n.text].join("\u0000"))
		.digest("hex")
		.slice(0, 16)}`;

/** The first thing wrong with a note, or undefined. */
function noteProblem(n: Note): string | undefined {
	if (!n.from) return "note: --from needs the sending thread's title";
	if (n.from.length > FROM_MAX_CHARS || /[\p{Cc}<>"]/u.test(n.from))
		return `note: --from is one line of at most ${FROM_MAX_CHARS} characters, with no quotes, angle brackets or control characters`;
	for (const [flag, v] of [
		["--thread", n.thread],
		["--server", n.server],
	] as const)
		if (v !== undefined && !TOKEN.test(v)) return `note: ${flag} is one token (letters, digits and . _ : % @ / -)`;
	if (!n.text) return "note: the note is empty";
	if (n.text.length > NOTE_MAX_CHARS)
		return `note: the note is ${n.text.length} characters, over ${NOTE_MAX_CHARS}: write the detail to a file and send its path`;
	return undefined;
}

/** Whether the daemon's heartbeat in this store is recent enough that something will send what is written here. */
function daemonLive(store: Store, now: number): boolean {
	const beat = store.state.get("heartbeat") as { t?: unknown } | undefined;
	const t = typeof beat?.t === "string" ? Date.parse(beat.t) : Number.NaN;
	return Number.isFinite(t) && now - t <= DAEMON_STALE_MS && t - now <= HEARTBEAT_SKEW_MS;
}

/** Holds one note for the Steward. Refuses a malformed note (code 2) and a store no live daemon reads (code 3), writing nothing. */
export function queueNote(store: Store, raw: Note, now = Date.now()): NoteResult {
	// Trimmed before the id is made, so the same note typed or piped (with its trailing newline) is one wake.
	const n = { ...raw, from: raw.from.trim(), text: raw.text.trim() };
	const problem = noteProblem(n);
	if (problem) return { ok: false, code: 2, error: problem };
	if (!daemonLive(store, now))
		return {
			ok: false,
			code: 3,
			error:
				"note: no Chamberlain daemon has run on this state directory in the last five minutes, so nothing would send this note. Run it on the Steward's machine, or send the report with t3_thread_send.",
		};
	const deliveryId = noteDeliveryId(n);
	const where = [n.server, n.thread].filter(Boolean).join(", ");
	const message = noteWakeText(n.from, where, n.text);
	// Bytes, not characters: the relay's replay bound is UTF-8, and a note must still fit once a Steward switch wraps it.
	if (exceedsEncodedCap(message, deliveryId, TRANSFER_DIGEST_MAX_BYTES - TRANSFER_WRAP_RESERVE_BYTES))
		return {
			ok: false,
			code: 2,
			error: "note: the note is too large to send once encoded (UTF-8): write the detail to a file and send its path",
		};
	const outbox = createOutbox({ store, log: () => {}, now: () => now });
	const meta = { kind: "note", ...(n.thread ? { thread: n.thread } : {}) };
	const status = outbox.deliver(message, deliveryId, meta);
	return { ok: true, deliveryId, status: status === "queued" ? "held" : "known" };
}
