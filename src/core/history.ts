/**
 * What a thread's latest instruction read says. Adapters with a history (`Adapter.inspect.instruction`, see adapter.ts)
 * return it; the core's report rules (decide.ts, report.ts) only need this shape.
 */
import type { TurnItem } from "./decide.ts";

/**
 * complete: the items hold the latest instruction, or the thread has none. truncated: paging stopped short, or the
 * backend offered no way further back. failed: the read itself went wrong. Only "complete" can mean there is nothing to report.
 */
export type InstructionRead = {
	items: TurnItem[];
	state: "complete" | "truncated" | "failed";
	error?: string;
	byMachine: boolean;
};

/** A read that found nothing to read with: what an adapter without a history reports, and what a failed read reports. */
export const failedRead = (error: string): InstructionRead => ({ items: [], state: "failed", error, byMachine: false });

/** The event for a wake that didn't go. A skip from a bad read must never look like a thread with nothing to report. */
export const skipEvent = (read: InstructionRead, clean: string) =>
	read.state === "failed" ? "skip-read-failed" : read.state === "truncated" ? "skip-read-truncated" : clean;
