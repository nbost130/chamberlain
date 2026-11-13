/**
 * Crash points for the crash tests. When CHAMBERLAIN_CRASH_AT names a step, the process kills itself with SIGKILL right
 * after that step, as a real crash would: no finally blocks, no flushes, no exit handlers. Unset, this does nothing.
 *
 * The steps are the points around each commit of the one-wake path (the database makes each commit atomic, so a crash
 * is either before it, when nothing of it exists, or after it, when all of it does):
 *
 *   before-commit    the page's answer transaction has written the claim, the answer, any ruling and the wake's outbox row but not
 *                    committed (src/web/app.ts): a kill here leaves none of them.
 *   committed        that transaction has committed: the claim, the answer and the pending outbox row are durable, nothing is sent.
 *   notified         inside the ONE transaction that records a notification decision (the notified keys of a daemon wake, the findings
 *                    and the clock of a sweep) and writes the wake's outbox or held row, before it commits (src/core/deliver.ts):
 *                    a kill here leaves neither, so the restart notifies again.
 *   enqueued         that transaction has committed: the decision and the wake's row both exist.
 *   composed         the relay's composition has committed: held items are bound to one new pending row (src/core/relay.ts).
 *   attempt-begun    inside the relay's attempt transaction, before it commits: the count is not raised and nothing is sent.
 *   attempt-counted  the attempt is committed and the POST has not been made.
 *   accepted         the transport accepted the POST and the row is not yet delivered: the documented window.
 *   delivered        the row is committed delivered and the answer it carries has not yet been marked delivered.
 */
export const CRASH_STEPS = ["before-commit", "committed", "notified", "enqueued", "composed", "attempt-begun", "attempt-counted", "accepted", "delivered"] as const;
export type CrashStep = (typeof CRASH_STEPS)[number];

export function crashPoint(step: CrashStep) {
	if (process.env.CHAMBERLAIN_CRASH_AT === step) process.kill(process.pid, "SIGKILL");
}
