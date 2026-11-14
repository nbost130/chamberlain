/** The relay's audit of the outbox: rows in the wrong state, orphaned rows and lanes. */
import { STALE_AFTER_MS } from "./deliver.ts";
import { observe } from "./hold.ts";
import { alarms } from "./messages.ts";
import { flagDead } from "./relay-compose.ts";
import { type Ctx, type Lane, raise } from "./relay-ctx.ts";
import type { OutboxRow } from "./store-wakes.ts";

/** Once a minute: keeps each receiver's busy stretch measured, and raises its stale and dead-letter alarms, and the orphan alarm. */
export function audit(r: Ctx) {
	for (const l of r.lanes) auditLane(r, l);
	auditOrphans(r);
}

/**
 * Rows (pending or dead-lettered) and held wakes whose receiver this relay has no transport for: a receiver removed from config while its
 * wakes were still waiting. They would wait forever, so each such receiver raises its own `<receiver>:wake-unconfigured` alarm, naming it
 * and the count, on the same repeat policy as every other alarm. They are never dropped and never sent elsewhere: the operator configures
 * the receiver again (they then go to it) or gives the rows up with `bun src/wakes.ts cancel <id>` (`list` shows each row's receiver).
 * Held wakes cannot be cancelled: they become a row only once their receiver is configured again.
 */
function auditOrphans(r: Ctx) {
	const { d } = r;
	for (const [name, o] of findOrphans(r)) {
		const n = o.rows.length;
		if (!r.reported.has(`orphan:${name}:${n}:${o.held}`)) {
			r.reported.add(`orphan:${name}:${n}:${o.held}`);
			d.log("deliver-receiver-unconfigured", { receiver: name, rows: n, held: o.held });
		}
		raise(
			r,
			`${name}:wake-unconfigured`,
			alarms.wakeOrphaned(
				name,
				o.rows.map((row) => row.deliveryId),
				o.held,
			),
		);
	}
}

/** The pending and dead-lettered rows, and the held wakes, of receivers this relay has no lane for, by receiver. */
function findOrphans(r: Ctx): Map<string, { rows: OutboxRow[]; held: number }> {
	const { store } = r;
	const known = new Set(r.lanes.map((l) => l.name));
	const orphans = new Map<string, { rows: OutboxRow[]; held: number }>();
	const of = (name: string) => {
		let o = orphans.get(name);
		if (!o) {
			o = { rows: [], held: 0 };
			orphans.set(name, o);
		}
		return o;
	};
	for (const row of [...store.wakes.rows("pending"), ...store.wakes.rows("dead_letter")])
		if (row.receiver && !known.has(row.receiver)) of(row.receiver).rows.push(row);
	for (const h of store.wakes.held()) if (h.receiver && !known.has(h.receiver)) of(h.receiver).held++;
	return orphans;
}

function auditLane(r: Ctx, l: Lane) {
	const { d, store } = r;
	const now = r.clock();
	try {
		observe(l.look, l.gate(), now, r.ceiling);
	} catch (e) {
		d.log("gate-error", { error: String(e).slice(0, 200), ...(l.name ? { receiver: l.name } : {}) });
	}
	const waiting = [
		...store.wakes.rows("pending", l.name).map((row) => ({ deliveryId: row.deliveryId, queuedAt: row.createdAt })),
		...store.wakes.held(l.name),
	];
	const old = waiting.filter((w) => now - w.queuedAt > (d.staleAfterMs ?? STALE_AFTER_MS));
	for (const w of old)
		if (!r.reported.has(`stale:${w.deliveryId}`)) {
			r.reported.add(`stale:${w.deliveryId}`);
			d.log("deliver-stale", { deliveryId: w.deliveryId, ageMs: now - w.queuedAt });
		}
	if (old.length)
		raise(
			r,
			l.akey("wake-stale"),
			alarms.wakesStale(l.desk, old.length, Math.round((d.staleAfterMs ?? STALE_AFTER_MS) / 3600_000)),
		);
	flagDead(r, l);
}
