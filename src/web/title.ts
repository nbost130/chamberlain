/**
 * Keeps the pinned Decisions thread's title showing how many questions wait on the principal ("Decisions · 2 waiting"), so the
 * thread list tells them at a glance. The rename is the adapter's `setTitle` (T3 does it with thread.metadata.update, which
 * needs the orchestration:operate token); without that capability, or without the token, the title stays as it was.
 */
/** Pure: the title for this many open questions. */
export const decisionsTitle = (open: number) => (open === 0 ? "Decisions · clear" : `Decisions · ${open} waiting`);

/** `Adapter.setTitle`: renames the Decisions thread, or says why it could not. */
export type SetTitle = (title: string) => Promise<"set" | "no-token" | "failed">;

/**
 * Pure apart from its deps: returns a tick that renames the thread when the count has changed since the last rename
 * that delivered. A failure or a missing token leaves `last` alone, so the next tick tries again.
 */
export function titleKeeper(openCount: () => number, set: SetTitle, log: (event: string, data?: Record<string, unknown>) => void) {
	let last: string | undefined;
	let lastOutcome: string | undefined;
	return async () => {
		const title = decisionsTitle(openCount());
		if (title === last) return;
		let outcome: string;
		try { outcome = await set(title); } catch (e) { outcome = "failed"; log("title-error", { error: String(e).slice(0, 200) }); }
		if (outcome === "set") { last = title; log("title-set", { title }); }
		else if (outcome !== lastOutcome) log("title-skipped", { outcome });
		lastOutcome = outcome;
	};
}
