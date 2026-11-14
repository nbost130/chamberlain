/** One pass of the relay over a lane: composing what is ready, sending it, and dead-lettering what cannot be sent. */
import { alarms } from "./messages.ts";
import { compose, land, serially } from "./relay-compose.ts";
import { type Ctx, type Lane, laneOf, raise } from "./relay-ctx.ts";
import { send } from "./relay-send.ts";
import type { OutboxRow } from "./store-wakes.ts";

/** One pass. Returns the delivery ids delivered in it (a digest's members). */
async function passOnce(r: Ctx): Promise<string[]> {
	if (!r.d.lock.held()) {
		if (!r.run.lockLost) {
			r.run.lockLost = true;
			r.d.log("relay-lock-released");
		}
		return [];
	}
	for (const row of [...r.owed.values()]) land(r, row);
	const ready = composeReady(r, r.clock());
	const out: string[] = [];
	// Every receiver's pending rows, oldest first: each receiver's own rows keep their order, and each row goes to its receiver's transport.
	for (const row of r.store.wakes.rows("pending")) {
		const l = laneOf(r, row.receiver);
		if (!l) {
			logUnrouted(r, row);
			continue;
		}
		if (!ready.has(l) || r.owed.has(row.id) || (r.notBefore.get(row.id) ?? -Infinity) > r.clock()) continue;
		const sent = await serially(r, () => send(r, l, row));
		for (const s of sent) out.push(...s.members.map((m) => m.deliveryId));
	}
	return out;
}

/** The lanes whose transport can send now, after composing their held wakes; a lane with work and nowhere to send raises its alarm once a minute. */
function composeReady(r: Ctx, now: number): Set<Lane> {
	const { d, store } = r;
	const ready = new Set<Lane>();
	for (const l of r.lanes) {
		if (l.wake.ready()) {
			ready.add(l);
			compose(r, l, now);
			continue;
		}
		if (
			now - l.notReadyAt >= 60_000 &&
			(store.wakes.held(l.name).length || store.wakes.rows("pending", l.name).length)
		) {
			l.notReadyAt = now;
			d.log("deliver-not-ready", l.name ? { receiver: l.name } : undefined);
			raise(r, l.akey("wake-not-ready"), alarms.wakeNowhere(l.desk));
		}
	}
	return ready;
}

/** A row whose receiver this relay has no transport for is logged once. */
function logUnrouted(r: Ctx, row: OutboxRow) {
	if (r.unrouted.has(row.id)) return;
	r.unrouted.add(row.id);
	r.d.log("deliver-no-receiver", { deliveryId: row.deliveryId, receiver: row.receiver });
}

/** One pass at a time; a call while one waits to start joins it. */
export function pass(r: Ctx): Promise<string[]> {
	const { run } = r;
	if (run.next) return run.next;
	const p = run.chain
		.then(() => {
			run.next = undefined;
			return passOnce(r);
		})
		.catch((e) => {
			r.d.log("relay-error", { error: String(e).slice(0, 200) });
			return [] as string[];
		});
	run.next = p;
	run.chain = p;
	return p;
}
