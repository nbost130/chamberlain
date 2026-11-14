/**
 * One stall (run-1 fails, a retry is due), then a fault at one point of the sequence, then, where the row says so, a restart, then the
 * next failure (run-2). Every row is checked against the same invariants:
 *   - at most one retry message reaches T3 for the stall (`sent`), and never a duplicate;
 *   - the counters match what happened: an attempt that may have been sent stays counted, one that was withdrawn leaves no trace, and
 *     no half-made attempt (`pending.attempt`) is left behind;
 *   - the next failure goes to the judge exactly when a retry may have gone out, and is a fresh first failure (retried once) otherwise.
 */
type Crash = "before-save" | "after-save" | "send-accepted" | "after-send" | "after-record";

export type Fault = "save-fails" | "refused" | "throws" | "unknown-error";

type Row = {
	name: string;
	/** a process death at this point (nothing after it happens in that process) */
	crash?: Crash;
	/** a failure at this point; it is injected in the process named by `on` */
	fault?: Fault;
	on?: "A" | "B";
	restart: boolean;
	/** retry messages that reached T3 */
	sent: number;
	/** the counters after the faulted attempt: pings counted, and whether a retry is recorded as made */
	counters: { pings: number; retried: boolean };
	/** what the next failure does */
	next: "verdict" | "retry-scheduled";
	/** a wake to the Steward about the retry, matching this */
	wake?: RegExp;
};

export const MATRIX: Row[] = [
	{ name: "no fault", restart: false, sent: 1, counters: { pings: 1, retried: true }, next: "verdict" },
	{
		name: "crash before the save",
		crash: "before-save",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
	},
	{
		name: "the save fails",
		fault: "save-fails",
		on: "A",
		restart: false,
		sent: 0,
		counters: { pings: 0, retried: false },
		next: "retry-scheduled",
		wake: /could not be saved \(disk full\)/,
	},
	{
		name: "the save fails, then a restart",
		fault: "save-fails",
		on: "A",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
		wake: /could not be saved \(disk full\)/,
	},
	{
		name: "crash after the save, before the send",
		crash: "after-save",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
	},
	{
		name: "crash with the send accepted",
		crash: "send-accepted",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
	},
	{
		name: "the send is refused (not sent)",
		fault: "refused",
		on: "A",
		restart: false,
		sent: 0,
		counters: { pings: 0, retried: false },
		next: "retry-scheduled",
		wake: /\(not sent: .*\), so nothing has been retried/,
	},
	{
		name: "crash after the save, restart, then the send is refused (not sent)",
		crash: "after-save",
		fault: "refused",
		on: "B",
		restart: true,
		sent: 0,
		counters: { pings: 0, retried: false },
		next: "retry-scheduled",
		wake: /\(not sent: .*\), so nothing has been retried/,
	},
	{
		name: "the send throws",
		fault: "throws",
		on: "A",
		restart: false,
		sent: 0,
		counters: { pings: 1, retried: true },
		next: "verdict",
		wake: /may have been delivered \(the send threw: socket hang up\); it is counted as sent/,
	},
	{
		name: "the send fails in a way that may have landed",
		fault: "unknown-error",
		on: "A",
		restart: false,
		sent: 0,
		counters: { pings: 1, retried: true },
		next: "verdict",
		wake: /may have been delivered \(.*send timed out.*\); it is counted as sent/,
	},
	{
		name: "crash after the send, before it is recorded",
		crash: "after-send",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
	},
	{
		name: "crash after the record",
		crash: "after-record",
		restart: true,
		sent: 1,
		counters: { pings: 1, retried: true },
		next: "verdict",
	},
];
