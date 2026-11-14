/**
 * The operator's commands for the outbox (`bun src/wakes.ts`). `list` shows what is waiting, `retry <id>` gives a dead-lettered row another
 * full set of attempts, `cancel <id>` gives a pending or dead-lettered row up and keeps it as a tombstone, so nothing enqueues it again.
 * Pure over a Store and an output function, so it is tested without a process. An id may be a row's own or one of a digest's members.
 * Each row names its receiver when it is not the Steward ("for desk"), so rows for a receiver removed from config (the relay's
 * `<receiver>:wake-unconfigured` alarm) can be found here and cancelled.
 *
 * Before retrying, look at the Steward's thread: a dead-lettered wake may well have reached the Steward, and the Steward treats a delivery
 * id it has already handled as a repeat. retry works only on a dead letter, which the relay never has in flight, so it cannot add a POST
 * beside a live one.
 */
import { selfCommand } from "./config.ts";
import { maxAttemptsFromEnv } from "./deliver.ts";
import type { OutboxRow, Store } from "./store.ts";

export const wakesUsage = () =>
	["list", "retry <delivery id>", "cancel <delivery id>"]
		.map((c, i) => `${i ? "       " : "usage: "}${selfCommand("wakes")} ${c}`)
		.join("\n");
const iso = (ms: number | undefined) => (ms === undefined ? "-" : new Date(ms).toISOString());
const line = (r: OutboxRow, max: number) =>
	`  ${r.deliveryId}${r.receiver ? `  for ${r.receiver}` : ""}  ${r.attempts}/${max} attempts  created ${iso(r.createdAt)}  last tried ${iso(r.lastAttemptAt)}${r.members.length > 1 || r.members[0]?.deliveryId !== r.deliveryId ? `  members ${r.members.map((m) => m.deliveryId).join(", ")}` : ""}`;

/** Runs one command. Returns the exit code: 0 done, 1 no row has that id or it is not in a state the command applies to, 2 usage. */
export function runWakesCli(
	store: Store,
	argv: readonly string[],
	out: (line: string) => void,
	env: Record<string, string | undefined> = process.env,
): number {
	const [cmd, id] = argv;
	const max = maxAttemptsFromEnv(env);
	if (cmd === "list" && argv.length === 1) {
		const dead = store.wakes.rows("dead_letter");
		out(
			`dead letters (attempted ${max} times without being delivered, not sent again until you retry or cancel): ${dead.length}`,
		);
		for (const r of dead) out(line(r, max));
		const pending = store.wakes.rows("pending");
		out(`pending (the daemon's relay is sending them): ${pending.length}`);
		for (const r of pending) out(line(r, max));
		out(`held for the Steward to go idle: ${store.wakes.held().length}`);
		const cancelled = store.wakes.rows("cancelled").length;
		if (cancelled) out(`cancelled (kept as tombstones, so nothing queues them again): ${cancelled}`);
		return 0;
	}
	if ((cmd === "retry" || cmd === "cancel") && id && argv.length === 2) {
		const was = cmd === "retry" ? store.wakes.retry(id) : store.wakes.cancel(id, Date.now());
		if (!was) {
			out(`${cmd}: no outbox row has the id ${id} ("list" shows what is waiting)`);
			return 1;
		}
		if (cmd === "retry" && was !== "dead_letter") {
			out(`retry: ${id} is ${was}, not a dead letter; only a dead letter can be retried`);
			return 1;
		}
		if (cmd === "cancel" && was !== "pending" && was !== "dead_letter") {
			out(`cancel: ${id} is already ${was}`);
			return 1;
		}
		out(
			cmd === "retry"
				? `retry: ${id} is pending again with its attempts at zero (up to ${max} more); the daemon's relay sends it on its next poll (one second by default, later if it is busy with an earlier row)`
				: `cancel: ${id} is cancelled and kept as a tombstone; it is not recorded as delivered and nothing will send or queue it again`,
		);
		return 0;
	}
	out(wakesUsage());
	return 2;
}
