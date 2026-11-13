import type { WaitingItem, WaitQuestion } from "../../core/adapter.ts";
import { normalizeWaitKind } from "./state.ts";

/**
 * The shape the T3 adapter expects of a thread projection (`orchestration.getThreadProjection`). Every read of one goes
 * through `checkProjection`: an answer in any other shape throws, so it is a failed read and never an empty thread.
 */
export type Projection = { turnItems: any[]; runs?: any[]; subagents?: { status?: string }[] };
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure: a projection in the shape the reads expect (an object whose `turnItems` is a list of objects), or a throw naming what is wrong. */
export function checkProjection(p: unknown): Projection {
	if (!isObject(p)) throw Error("malformed projection: not an object");
	if (!Array.isArray(p.turnItems)) throw Error("malformed projection: turnItems is not a list");
	if (!p.turnItems.every(isObject)) throw Error("malformed projection: a turn item is not an object");
	for (const k of ["runs", "subagents"] as const) if (p[k] !== undefined && !Array.isArray(p[k])) throw Error(`malformed projection: ${k} is not a list`);
	return p as Projection;
}

/** The turn-item types the adapter treats as cards: a question, an approval, a secret, and a link request under any of T3's names. */
export const isCardType = (type: string): boolean => ["user_input_request", "approval_request", "secret_request", "link_request"].includes(normalizeWaitKind(type));

/**
 * The turn-item statuses that mean a card is RESOLVED, in T3's own lifecycle (packages/contracts orchestrationV2.ts, the
 * Orchestrator and the recovery service): `completed` (approved, answered, secret saved), `cancelled` (declined, cancelled, or
 * expired during startup recovery), `failed` (an approval callback lost on a runtime error), `interrupted`. Seeing a card's own
 * item in one of these is the only evidence that closes its hold.
 */
export const TERMINAL_CARD_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "interrupted"]);
/** The other statuses T3's turn-item schema allows. A card in one of these is still open; its hold stays. */
export const OPEN_CARD_STATUSES: ReadonlySet<string> = new Set(["idle", "pending", "running", "waiting"]);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const asText = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Pure: a projection's turn items read as cards (adapter.ts `WaitingRead`). Per item, never all or nothing: one bad item can
 * neither hide another card nor close one. A card item has a type that is a request kind (`isCardType`) and its key is
 * `requestId ?? id` (T3's approval items carry `requestId`; its secret and user-input items carry only `id`), a non-empty
 * string. An item that names a different `threadId` than the thread read belongs to another thread and is passed over.
 * A card with an item in status "waiting" is listed in `cards`. A card is listed in `resolved` only when it has an item in a
 * status of `TERMINAL_CARD_STATUSES` and NO item of it is still going or unreadable: an ID that also appears on an open, unknown
 * or missing status is not resolved, so a card never closes while one of its own items still waits. Every skipped item (no
 * key, no or an unknown status) gets a reason in `ignored`. Items that are not cards, and items with no type, are passed over.
 *
 * The projection is a BOUNDED window of the thread's history (T3's `buildBoundedThreadProjection`; the RPC drops its
 * `hasMoreHistory` flag), so a card missing from it may still be waiting: absence is never read as anything.
 */
export function readCards(turnItems: readonly unknown[], threadId: string): { ok: true; cards: WaitingItem[]; resolved: string[]; ignored: string[] } {
	const ignored: string[] = [];
	const terminal = new Set<string>();
	const notDone = new Set<string>();
	const waiting = new Map<string, { item: Record<string, unknown>; type: string }>();
	for (const [n, i] of turnItems.entries()) {
		if (!isObject(i) || !nonEmpty(i.type) || !isCardType(i.type)) continue;
		if (i.threadId !== undefined && i.threadId !== null && i.threadId !== threadId) continue;
		const at = `card item ${n} (${i.type})`;
		const id = i.requestId ?? i.id;
		if (!nonEmpty(id)) { ignored.push(`${at} has no valid request id`); continue; }
		if (typeof i.status !== "string" || i.status === "") { ignored.push(`${at} ${id} has no status`); notDone.add(id); continue; }
		if (TERMINAL_CARD_STATUSES.has(i.status)) { terminal.add(id); continue; }
		notDone.add(id);
		if (!OPEN_CARD_STATUSES.has(i.status)) { ignored.push(`${at} ${id} has an unknown status ${JSON.stringify(i.status).slice(0, 40)}`); continue; }
		if (i.status === "waiting" && !waiting.has(id)) waiting.set(id, { item: i, type: i.type });
	}
	const cards: WaitingItem[] = [...waiting].map(([id, c]) => {
		const questions = (Array.isArray(c.item.questions) ? c.item.questions.filter(isObject) : []) as (WaitQuestion & { header?: string })[];
		return { type: normalizeWaitKind(c.type) as WaitingItem["type"], requestId: id, label: asText(c.item.label) || asText(c.item.prompt) || asText(questions[0]?.header), questions };
	});
	const resolved = [...terminal].filter((id) => !notDone.has(id));
	for (const id of terminal) if (notDone.has(id)) ignored.push(`card ${id} has a terminal item and one still going or unreadable: not resolved`);
	return { ok: true, cards, resolved, ignored };
}
