/**
 * The operator's commands for the outbox (`bun src/wakes.ts`). `list` shows what is waiting, `retry <id>` gives a dead-lettered row another
 * full set of attempts, `cancel <id>` gives a pending or dead-lettered row up and keeps it as a tombstone, so nothing enqueues it again.
 * Pure over a Store and an output function, so it is tested without a process. An id may be a row's own or one of a digest's members,
 * except that `cancel` takes a digest only by its own id: a member's id would give up every other member with it, so it is refused and the
 * digest and its members are named.
 * Each row names its receiver when it is not the Steward ("for desk"), so rows for a receiver removed from config (the relay's
 * `<receiver>:wake-unconfigured` alarm) can be found here and cancelled.
 *
 * Before retrying, look at the Steward's thread: a dead-lettered wake may well have reached the Steward, and the Steward treats a delivery
 * id it has already handled as a repeat. retry works only on a dead letter, which the relay never has in flight, so it cannot add a POST
 * beside a live one.
 */
import { selfCommand } from "../config/config.ts";
import { releaseWake } from "../steward/steward-discharge.ts";
import { TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { Store } from "../store/store.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import { maxAttemptsFromEnv } from "./deliver.ts";

export const wakesUsage = () =>
	["list", "retry <delivery id>", "cancel <delivery id>", "release <delivery id>"]
		.map((c, i) => `${i ? "       " : "usage: "}${selfCommand("wakes")} ${c}`)
		.join("\n");
const iso = (ms: number | undefined) => (ms === undefined ? "-" : new Date(ms).toISOString());
const line = (r: OutboxRow, max: number) =>
	`  ${r.deliveryId}${r.receiver ? `  for ${r.receiver}` : ""}  ${r.attempts}/${max} attempts  created ${iso(r.createdAt)}  last tried ${iso(r.lastAttemptAt)}${r.members.length > 1 || r.members[0]?.deliveryId !== r.deliveryId ? `  members ${r.members.map((m) => m.deliveryId).join(", ")}` : ""}`;

type Out = (line: string) => void;

/** `list`: the dead letters, the pending rows, the held count and the cancelled count. */
function listWakes(store: Store, max: number, out: Out): number {
	const dead = store.wakes.rows("dead_letter");
	out(
		`dead letters (attempted ${max} times without being delivered, not sent again until you retry or cancel): ${dead.length}`,
	);
	for (const r of dead) out(line(r, max));
	const pending = store.wakes.rows("pending");
	out(`pending (the daemon's relay is sending them): ${pending.length}`);
	for (const r of pending) out(line(r, max));
	const held = store.wakes.held();
	out(`held for the Steward to go idle: ${held.length}`);
	for (const h of held)
		out(
			`  ${h.deliveryId}${h.kind ? `  ${h.kind}` : ""}${h.receiver ? `  for ${h.receiver}` : ""}  held ${iso(h.queuedAt)}`,
		);
	const cancelled = store.wakes.rows("cancelled").length;
	if (cancelled) out(`cancelled (kept as tombstones, so nothing queues them again): ${cancelled}`);
	return 0;
}

/**
 * Why `cancel <id>` must not run, or undefined. A held wake is not sent yet and has no row to cancel. A member of a digest is refused: the
 * digest is one row, so cancelling it gives up every member, and the operator names the digest by its own id to mean that.
 */
function cancelRefusal(store: Store, id: string): string | undefined {
	if (store.wakes.held().some((h) => h.deliveryId === id))
		return `cancel: ${id} is held, not sent yet: it goes in the Steward's next wake, and there is no row to cancel until then`;
	const row = store.wakes.find(id);
	if (!row || row.deliveryId === id || row.members.length < 2) return undefined;
	return `cancel: ${id} is one of ${row.members.length} wakes in digest ${row.deliveryId} (${row.members.map((m) => m.deliveryId).join(", ")}). Cancelling gives up all of them: to do that, cancel ${row.deliveryId}`;
}

/** `retry <id>` or `cancel <id>`: what the row was decides whether the command applied. */
function retryOrCancel(
	store: Store,
	{ cmd, id, max }: { cmd: "retry" | "cancel"; id: string; max: number },
	out: Out,
): number {
	const refused = cmd === "cancel" ? cancelRefusal(store, id) : undefined;
	if (refused) {
		out(refused);
		return 1;
	}
	const members = store.wakes.find(id)?.members.map((m) => m.deliveryId) ?? [];
	const was = cmd === "retry" ? store.wakes.retry(id) : store.wakes.cancel(id, Date.now());
	if (!was) {
		out(`${cmd}: no outbox row has the id ${id} ("list" shows what is waiting)`);
		return 1;
	}
	if (cmd === "retry" && was === "oversized") {
		out(
			`retry: ${id} is over the ${TRANSFER_DIGEST_MAX_BYTES}-byte encoded replay bound (delivery framing included); shrink or split the frozen payload. The row stays dead_letter; nothing will send it.`,
		);
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
			: `cancel: ${id} is cancelled and kept as a tombstone; it is not recorded as delivered and nothing will send or queue it again${members.length > 1 ? `. It was a digest, so every wake it carried is given up with it: ${members.join(", ")}` : ""}`,
	);
	return 0;
}

/** Runs one command. Returns the exit code: 0 done, 1 no row has that id or it is not in a state the command applies to, 2 usage. */
export function runWakesCli(
	store: Store,
	argv: readonly string[],
	out: Out,
	env: Record<string, string | undefined> = process.env,
): number {
	const [cmd, id] = argv;
	const max = maxAttemptsFromEnv(env);
	if (cmd === "list" && argv.length === 1) return listWakes(store, max, out);
	if ((cmd === "retry" || cmd === "cancel") && id && argv.length === 2)
		return retryOrCancel(store, { cmd, id, max }, out);
	if (cmd === "release" && id && argv.length === 2) {
		if (!releaseWake(store, id)) {
			out(`release: no outbox row has the id ${id}`);
			return 1;
		}
		out(`release: operator receipt recorded for ${id}; it may prune once aged`);
		return 0;
	}
	out(wakesUsage());
	return 2;
}
