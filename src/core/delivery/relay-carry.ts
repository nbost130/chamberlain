/**
 * Held news rides with an immediate wake. A wake that is not held (needs_input, a failure, a message) goes at once; held turn ends, notes and
 * sweeps, waiting for company, used to stay behind it and go as a second Steward turn a few minutes later. Now the news goes INSIDE the immediate
 * wake's own POST, under its own delivery id, and is bound delivered with it. The queued row is never edited: only the POSTed text differs.
 */
import { scrubSecretHeldMessages } from "../items/questions-claim.ts";
import { encodedSendBytes, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { OutboxRow } from "../store/store-wakes.ts";
import { DELIVERY_ID_LINE } from "./deliver.ts";
import { digestOf, land } from "./relay-compose.ts";
import type { Carried, Ctx, Landing, Lane } from "./relay-ctx.ts";

/** Room kept in the POST for the full rights, which may ride in it too (the largest block in use was 9 KB). */
const RIGHTS_RESERVE_BYTES = 10_000;
/** Rows that are themselves a batch or a prerequisite: nothing rides in them. */
const NOT_CARRYING: ReadonlySet<string> = new Set(["rights", "digest", "transfer"]);

/** A wake that is its own one member: sent at once, not composed from held items. */
const immediate = (row: OutboxRow) => row.members.length === 1 && row.members[0]?.deliveryId === row.deliveryId;

/** The held news (never a transfer) that fits beside this row and its rights in one POST, or undefined. Writes nothing. */
export function previewCarry(r: Ctx, l: Lane, row: OutboxRow): Carried | undefined {
	if (l.desk || (row.kind && NOT_CARRYING.has(row.kind)) || !immediate(row)) return undefined;
	const held = r.store.wakes.held(l.name).filter((h) => h.kind !== "transfer");
	const room = TRANSFER_DIGEST_MAX_BYTES - encodedSendBytes(row.message, row.deliveryId) - RIGHTS_RESERVE_BYTES;
	if (!held.length || room <= 0) return undefined;
	const now = r.clock();
	try {
		const c = digestOf(l, scrubSecretHeldMessages(r.store, held), now, {
			onKept: () => {},
			answerDue: false,
			news: r.news,
			maxBytes: room,
		});
		return { now, members: c.members, text: c.message, rights: c.rights ?? [], maxBytes: room };
	} catch {
		return undefined;
	}
}

/**
 * The row as it is POSTed with the news: its own text, then the news (the delivery-id line stays last), and the news's rights stamps beside its
 * own. A row that already carries the full block satisfies the news's pointers (they say "unchanged"; the block is in the same wake), so only the
 * news's own full stamps join it, to be checked for staleness like any other.
 */
export function withNews(row: OutboxRow, c: Carried): OutboxRow {
	const body = row.message.replace(DELIVERY_ID_LINE(row.deliveryId), "").trimEnd();
	const full = (row.rights ?? []).some((s) => s.full);
	return {
		...row,
		message: `${body}\n\n${c.text}`,
		rights: [...(row.rights ?? []), ...c.rights.filter((s) => s.full || !full)],
	};
}

/**
 * Binds the news that rode in the row's POST as one DELIVERED row (`news-carried`), so it is never sent again. It runs inside the wake's own
 * delivered commit (`land`'s `alongside`), so the two are one commit. Throws when the news cannot be bound: nothing commits and the wake stays owed.
 */
function bindCarried(r: Ctx, l: Lane, c: Carried): OutboxRow | undefined {
	const ids = new Set(c.members);
	const row = r.store.wakes.compose(
		c.now,
		(held) =>
			digestOf(
				l,
				scrubSecretHeldMessages(
					r.store,
					held.filter((h) => ids.has(h.deliveryId)),
				),
				c.now,
				{
					onKept: () => {},
					answerDue: false,
					news: r.news,
					maxBytes: c.maxBytes,
				},
			),
		l.name,
	);
	if (!row) return undefined;
	if (!r.store.wakes.finish(row.id, "delivered", r.clock())) throw new Error("the carried news row was not pending");
	if (!row.receiver) {
		const gen = r.store.steward.maxGen();
		if (gen >= 1) r.store.steward.insertLedger({ outboxId: row.id, gen, origin: "live" });
	}
	r.d.log("news-carried", { deliveryId: row.deliveryId, members: c.members });
	return row;
}

/**
 * The row's delivered commit with everything that rode in its POST: the rights record from the block that rode in it, and the news bound
 * delivered in the same transaction. The first try and every retry of an owed commit (`relay-pass.ts`) go through here, so none loses either.
 */
export function landWith(r: Ctx, row: OutboxRow, g: Landing): boolean {
	return land(r, row, g.inline, g.carried ? () => bindCarried(r, g.l, g.carried as Carried) : undefined);
}
