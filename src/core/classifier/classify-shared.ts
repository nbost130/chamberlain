/** What the classifier's modules share: the day, short text, and the key and decision a thread's classification is cached under. */
import type { DispositionKey } from "../store-records.ts";
import { combine, type Decision } from "./bank.ts";
import type { Classified, ClassifyThread, Run } from "./classify.ts";

export const DAY_MS = 24 * 3600_000;

export const short = (e: unknown) =>
	String(e instanceof Error ? e.message : e)
		.slice(0, 200)
		.toWellFormed();
export const unknownOf = (error: string): Classified => ({ action: "unknown", reasons: [], error });
export const decided = (d: Decision): Classified => ({ action: d.action, reasons: d.reasons });

export const keyOf = (t: ClassifyThread) => `${t.server}:${t.threadId}:${t.lastMessageHash}`;
export const dispositionKey = (t: ClassifyThread, version: string): DispositionKey => ({
	server: t.server,
	threadId: t.threadId,
	messageHash: t.lastMessageHash,
	bankVersion: version,
});

export const decide = (run: Run, t: ClassifyThread, answers: Record<string, number>) =>
	combine(
		run.bank,
		answers,
		{ humanAsked: t.previous.from === "human", idleMinutes: t.idleMinutes },
		{ thresholds: run.c.thresholds, armedGraceMinutes: run.c.armedGraceMinutes },
	);
