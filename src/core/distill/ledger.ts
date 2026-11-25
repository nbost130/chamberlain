import { QUEUE } from "../items/questions.ts";
import { HELD } from "../ops/afk-held.ts";
import { openReadOnlyDatabase, queries } from "../store/database.ts";
import { makeClaims } from "../store/sqlite-claims.ts";
import { makeItems } from "../store/sqlite-items.ts";
import { makeEvents } from "../store/sqlite-log.ts";
import { makeDecisions } from "../store/sqlite-rulings.ts";
import type { Span } from "./window.ts";

/** An owned interval for a Steward thread, clipped to the report. Historical generations may reuse a thread. */
export type StewardPeriod = Span & { thread: string };
type Generation = { thread: string; createdAt: number };

function stewardPeriods(gens: Generation[], span: Span, legacyThread?: string): StewardPeriod[] {
	if (!gens.length) return legacyThread ? [{ ...span, thread: legacyThread }] : [];
	if ((gens[0]?.createdAt ?? Infinity) > span.from) return [];
	return gens.flatMap(({ thread, createdAt }, index) => {
		const from = Math.max(span.from, createdAt);
		const to = Math.min(span.to, gens[index + 1]?.createdAt ?? span.to);
		return from < to ? [{ thread, from, to }] : [];
	});
}

/** One read snapshot. Opening the source cannot run migrations, initialize config or write telemetry. */
export function readDistillLedger(path: string, span: Span, chat: boolean, legacyThread?: string) {
	const db = openReadOnlyDatabase(path);
	try {
		const q = queries(db);
		return db.transaction(() => ({
			cards: makeItems(q).list({ source: QUEUE, kind: "question" }),
			claims: makeClaims(q).list(QUEUE),
			holds: makeItems(q).list({ source: HELD, kind: "hold" }),
			decisions: makeDecisions(q).list(),
			snoozes: makeEvents(q).query({
				since: new Date(span.from).toISOString(),
				until: new Date(span.to).toISOString(),
				events: ["snoozed"],
			}),
			stewards: chat
				? stewardPeriods(
						q.all("SELECT thread, created_at AS createdAt FROM steward_gens ORDER BY gen") as Generation[],
						span,
						legacyThread,
					)
				: [],
		}))();
	} finally {
		db.close();
	}
}

export type DistillLedger = ReturnType<typeof readDistillLedger>;
