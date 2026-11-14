/**
 * Append one self-answer to the audit log (the `decisions` table):
 *   bun src/core/decided.ts "<thread>" "<what I decided>" "<ruling cited>" ["<ref>"]
 *   bun src/core/decided.ts list [n]        (the last n decisions, default 15)
 * Lead the citation with the ruling's ID ("R12", or "R12, R30: why") so the rulings page can count it. Free text still
 * works; it is kept, and counts toward no ruling.
 */
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import { citedIds } from "./rulings-read.ts";
import type { DecisionRow } from "./store.ts";

export type DecisionRecord = DecisionRow;

/** Pure: the log line for one decision. */
export function decisionRecord(
	{ thread, decision, ruling, ref }: { thread: string; decision: string; ruling: string; ref?: string },
	t = new Date().toISOString(),
): DecisionRecord {
	const ids = citedIds(ruling);
	return { t, thread, decision, ruling, ...(ids.length ? { rulingIds: ids } : {}), ref: ref ?? null };
}

export function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const [thread, decision, ruling, ref] = argv;
	if (thread === "list") {
		const n = Math.max(1, Number(decision ?? 15) || 15);
		for (const d of defaultStore().decisions.list().slice(-n))
			console.log(`${d.t}\t${d.thread}\t${d.decision}\t${d.ruling}`);
		process.exit(0);
	}
	if (!thread || !decision || !ruling) {
		console.error('usage: decided.ts "<thread>" "<what I decided>" "<ruling cited, led by its ID: R12>" ["<ref>"]');
		process.exit(2);
	}
	const rec = decisionRecord({ thread, decision, ruling, ref });
	defaultStore().decisions.append(rec);
	console.log(rec.rulingIds ? `logged, citing ${rec.rulingIds.join(", ")}` : "logged");
}

if (import.meta.main) main();
