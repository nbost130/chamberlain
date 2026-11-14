/** Listing one T3 server's waiting cards: its shell snapshot, each thread's projection, and the goal proposals found in idle threads. */
import type { ListWaitingOptions } from "../../core/adapter-waiting.ts";
import { readToken, redact } from "./ping.ts";
import type { Rpc } from "./rpc.ts";
import {
	BUSY,
	type CardScope,
	cardsFrom,
	goalCard,
	goalProposal,
	type MirrorCard,
	type ShellThread,
} from "./wait-cards.ts";
import type { Conn, Ctx, GoalSeen } from "./wait-ctx.ts";

const GOAL_WINDOW_MS = 7 * 24 * 3600_000;
const GOAL_READS_PER_POLL = 40;

/** The first shell snapshot of a server: every thread with its waiting request, if any. */
async function snapshot(rpc: Rpc, timeoutMs = 10_000): Promise<ShellThread[]> {
	return await new Promise<ShellThread[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error("snapshot timed out")), timeoutMs);
		rpc
			.call("orchestration.subscribeShell", {}, (v) => {
				if (v?.kind === "snapshot" && v.snapshot) {
					clearTimeout(timer);
					// A snapshot with no thread list, or a thread with no id, is malformed: an empty mirror would say nothing waits.
					const threads: unknown = v.snapshot.threads;
					if (
						!Array.isArray(threads) ||
						!threads.every(
							(t) =>
								typeof t === "object" &&
								t !== null &&
								typeof (t as ShellThread).id === "string" &&
								(t as ShellThread).id !== "",
						)
					)
						reject(Error("malformed snapshot"));
					else resolve(threads as ShellThread[]);
				}
			})
			.catch((e) => {
				clearTimeout(timer);
				reject(e);
			});
	});
}

/** What one listing reads: the open socket, the server's threads, the threads to skip, whether answers are allowed, and each thread's link. */
type Scan = {
	rpc: Conn;
	all: ShellThread[];
	skip: ReadonlySet<string>;
	canAnswer: boolean;
	link: (t: ShellThread) => string | undefined;
};

export async function listWaitingOn(ctx: Ctx, o: ListWaitingOptions): Promise<MirrorCard[]> {
	const { d, s, ms } = ctx;
	const token = readToken(d.conf, s.tokenFile);
	// No token is a server that cannot be read, not one with nothing waiting: the page keeps its last cards and says so.
	if (!token) throw Error(`no ${s.tokenFile}`);
	const skip = new Set(o.skipThreads);
	const canAnswer = Boolean(readToken(d.conf, s.operateTokenFile));
	// Warm the thread links: the environment read runs beside this listing and never delays it.
	void d.linker?.ready();
	try {
		const rpc = await ctx.open(token);
		try {
			const all = await snapshot(rpc as Rpc, ms);
			// The page's own link prefix wins; else the server's own link. Never waited for: until the server's environment is known
			// (read in the background, started below and by the first link asked for) a card has no link.
			const link = (t: ShellThread) => (o.linkBase ? `${o.linkBase}${t.id}` : d.linker?.links(t.id)?.ref);
			const scan: Scan = { rpc, all, skip, canAnswer, link };
			const cards = await questionCardsOf(ctx, scan);
			cards.push(...(await goalCardsOf(ctx, scan)));
			return cards;
		} finally {
			rpc.ws.close();
		}
	} catch (e) {
		throw Error(redact(String(e instanceof Error ? e.message : e), ctx.secrets()).slice(0, 200));
	}
}

/** The cards of every thread that has a pending request: its projection is read and its waiting items listed. */
async function questionCardsOf(ctx: Ctx, scan: Scan): Promise<MirrorCard[]> {
	const threads = scan.all.filter((t) => t.pendingRuntimeRequest?.id && !t.archivedAt && !scan.skip.has(t.id));
	const cards: MirrorCard[] = [];
	for (const t of threads) {
		const p = await ctx.project(scan.rpc, t.id);
		const scope: CardScope = { server: ctx.s.name, canAnswer: scan.canAnswer, thread: t, link: scan.link(t) };
		cards.push(...cardsFrom(scope, p.turnItems, p.runs));
	}
	return cards;
}

/** Pure: whether a thread is scanned for a goal proposal: idle, unsettled and unarchived, not skipped, nothing pending. */
const goalCandidate = (t: ShellThread, skip: ReadonlySet<string>): boolean =>
	!(
		t.archivedAt ||
		skip.has(t.id) ||
		t.pendingRuntimeRequest?.id ||
		BUSY.has(String(t.status ?? "")) ||
		(t.settledAt && !t.unsettledAt)
	);

/** Goal proposals: idle, unsettled, unarchived threads changed in the last week. */
async function goalCardsOf(ctx: Ctx, scan: Scan): Promise<MirrorCard[]> {
	const { s, goalSeen } = ctx;
	const budget = { reads: 0 };
	const now = Date.now();
	const eligible = new Set<string>();
	const cards: MirrorCard[] = [];
	for (const t of scan.all) {
		if (!goalCandidate(t, scan.skip)) continue;
		const at = String(t.updatedAt ?? "");
		if (!at || now - Date.parse(at) > GOAL_WINDOW_MS) continue;
		const key = `${s.name}\0${t.id}`;
		eligible.add(key);
		const seen = await goalSeenFor(ctx, scan.rpc, { key, threadId: t.id, at }, budget);
		if (seen?.proposal) {
			cards.push(goalCard({ server: s.name, canAnswer: scan.canAnswer, thread: t, link: scan.link(t) }, seen.proposal));
		}
	}
	// Forget threads that left the scan (busy, settled, archived, aged out or gone), so the cache stays bounded.
	for (const key of goalSeen.keys()) if (key.startsWith(`${s.name}\0`) && !eligible.has(key)) goalSeen.delete(key);
	return cards;
}

/** A thread's goal proposal as last read: the cached read when its `updatedAt` is unchanged, else a fresh one, while the poll's read budget lasts (then none). */
async function goalSeenFor(
	ctx: Ctx,
	rpc: Conn,
	{ key, threadId, at }: { key: string; threadId: string; at: string },
	budget: { reads: number },
): Promise<GoalSeen | undefined> {
	const seen = ctx.goalSeen.get(key);
	if (seen && seen.updatedAt === at) return seen;
	if (budget.reads >= GOAL_READS_PER_POLL) return undefined;
	budget.reads++;
	const p = await ctx.project(rpc, threadId);
	const fresh = { updatedAt: at, proposal: goalProposal(p.turnItems) };
	ctx.goalSeen.set(key, fresh);
	return fresh;
}
