/**
 * When the principal last wrote in a T3 thread. T3 marks a message `createdBy: "user"` for the principal's own clients (`mobile`, `web`) but also
 * for what a tool or the daemon posts as the principal (`mcp`: the Decisions thread's cards and the Steward's relays; `server`: a Codex card's
 * answer record), so the author alone says nothing: a message counts only when it came from a client a person types in, and only the clients
 * named here (`PERSON_SOURCES`) are known to be. A missing or unknown source is not the principal's: the worst of that is a card that was not held.
 */
import type { TurnItem } from "../../core/decide/decide.ts";
import { HISTORY_PAGES_MAX, type HistoryGet } from "./history.ts";

const PERSON_SOURCES: ReadonlySet<string> = new Set(["mobile", "web"]);
/** History pages read before the answer is "cannot tell". A page holds up to 75 conversation items, so this reaches far past any window. */
const PAGES_MAX = 3;

type Bounded = { projection?: { turnItems?: TurnItem[] }; historyCursor?: string | null; hasMoreHistory?: boolean };
type Page = {
	items?: { visibility?: string; sourceThreadId?: string; item?: TurnItem }[];
	nextCursor?: string | null;
	hasMoreHistory?: boolean;
};

/** Pure: is this item a message the principal typed? */
export const isPrincipalMessage = (i: TurnItem): boolean =>
	i.type === "user_message" && i.createdBy === "user" && PERSON_SOURCES.has(String(i.creationSource ?? ""));

/** Pure: the time of the newest message of the principal's among `items` (none after `until`, when given), in epoch milliseconds, or undefined. */
export function lastPrincipalWrite(items: readonly TurnItem[], until = Number.POSITIVE_INFINITY): number | undefined {
	let last: number | undefined;
	for (const i of items) {
		const t = Date.parse(i.updatedAt ?? "");
		if (isPrincipalMessage(i) && Number.isFinite(t) && t <= until && (last === undefined || t > last)) last = t;
	}
	return last;
}

/** Pure: the oldest time among `items`, or undefined when none carries one. A retained interrupt request sits in T3's window whatever its age, so it says nothing about how far back the items reach. */
function oldest(items: readonly TurnItem[]): number | undefined {
	const ts = items
		.filter((i) => i.type !== "run_interrupt_request")
		.map((i) => Date.parse(i.updatedAt ?? ""))
		.filter(Number.isFinite);
	return ts.length ? Math.min(...ts) : undefined;
}

/** Pure: the items of a history page that belong to this thread (a forked thread's pages also carry its parent's rows). */
function localItems(page: Page, threadId: string): TurnItem[] {
	if (!Array.isArray(page.items)) throw Error("history page had no items");
	return page.items
		.filter((r) => (r.sourceThreadId === undefined ? r.visibility === "local" : r.sourceThreadId === threadId))
		.flatMap((r) => (r.item ? [r.item] : []));
}

type PrincipalItem = TurnItem & { threadId?: string; messageId?: string; itemId?: string };

function addMessages(
	messageIds: Set<string>,
	items: PrincipalItem[],
	threadId: string,
	{ from, to }: { from: number; to: number },
): void {
	for (const item of items) {
		if (item.threadId !== undefined && item.threadId !== threadId) continue;
		if (!isPrincipalMessage(item)) continue;
		const time = Date.parse(item.updatedAt ?? "");
		if (!Number.isFinite(time)) throw Error("operator timestamp unavailable");
		if (time < from || time >= to) continue;
		const id = item.messageId ?? item.id ?? item.itemId;
		if (!id) throw Error("operator message identity unavailable");
		messageIds.add(id);
	}
}

/** Count once per local operator message. Nothing from the response is returned except the count. */
export async function countPrincipalMessages(
	threadId: string,
	get: HistoryGet,
	span: { from: number; to: number },
): Promise<number> {
	const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
	const bounded = (await get(`${base}/bounded`)) as Bounded;
	if (!Array.isArray(bounded.projection?.turnItems)) throw Error("operator history unavailable");
	let items = bounded.projection.turnItems;
	let more = bounded.hasMoreHistory;
	let cursor = bounded.historyCursor;
	const messageIds = new Set<string>();
	const visited = new Set<string>();
	for (let pages = 0; ; pages++) {
		addMessages(messageIds, items, threadId, span);
		if (more === false || (oldest(items) ?? Infinity) < span.from) return messageIds.size;
		if (more !== true || !cursor || visited.has(cursor) || pages === HISTORY_PAGES_MAX)
			throw Error("operator history did not reach the window");
		visited.add(cursor);
		const page = (await get(`${base}/history?cursor=${encodeURIComponent(cursor)}&view=conversation`)) as Page;
		items = localItems(page, threadId);
		more = page.hasMoreHistory;
		cursor = page.nextCursor;
	}
}

/**
 * The principal's last message in the thread at or after `since`, or undefined when there is none since then. The newest items come first
 * (`/bounded`); history pages (the conversation view, without tool noise) are read back only while the oldest item seen is still newer than `since`
 * and the thread has more. Throws when it cannot tell: a read that fails, a page that is not a page, or a thread so busy that `PAGES_MAX` pages
 * never reach back past `since`. `until` ignores messages after it and `pagesMax` raises the page budget: both are for replaying the past (the dry run
 * of what this would have held); the live read gives neither.
 */
export async function readPrincipalLastWrite(
	threadId: string,
	get: HistoryGet,
	since: number,
	opts: { until?: number; pagesMax?: number } = {},
): Promise<number | undefined> {
	const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
	const bounded = (await get(`${base}/bounded`)) as Bounded;
	if (!Array.isArray(bounded.projection?.turnItems)) throw Error("bounded snapshot had no turnItems");
	let items = bounded.projection.turnItems;
	let { hasMoreHistory: more, historyCursor: cursor } = bounded;
	for (let pages = 0; ; pages++) {
		const found = lastPrincipalWrite(items, opts.until);
		if (found !== undefined) return found >= since ? found : undefined;
		const first = oldest(items);
		if (!more || (first !== undefined && first < since)) return undefined;
		if (!cursor || pages === (opts.pagesMax ?? PAGES_MAX))
			throw Error("the thread's history did not reach back past the window");
		const page = (await get(`${base}/history?cursor=${encodeURIComponent(cursor)}&view=conversation`)) as Page;
		items = [...localItems(page, threadId), ...items];
		more = page.hasMoreHistory;
		cursor = page.nextCursor;
	}
}
