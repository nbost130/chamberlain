/** Claims, direct relays, evidence, the key-value state and the store sequence. */

import { type Db, json, parse, type Row, required } from "./sqlite-db.ts";
import { itemId } from "./sqlite-items.ts";
import type { ClaimRecord, EvidenceRow, RelayRecord, Store } from "./store.ts";

// ---- claims, relays, evidence -------------------------------------------------------------------
const toClaim = (r: Row): ClaimRecord => ({
	owner: r.owner as string,
	item: r.item_key as string,
	deliveryId: r.delivery_id as string,
	message: r.message as string,
	t: r.claimed_at as string,
	...(r.answer !== null ? { answer: parse(r.answer) } : {}),
	...(r.ruling !== null ? { ruling: parse(r.ruling) } : {}),
	...(r.relay !== null ? { relay: parse(r.relay) } : {}),
});
const claimRow = (c: Db, source: string, item: string) =>
	c.one(
		"SELECT c.*, i.dedup_key AS item_key FROM claims c JOIN items i ON i.id = c.item_id WHERE i.source = ? AND i.dedup_key = ?",
		source,
		item,
	);
const toRelay = (r: Row): RelayRecord => ({
	started: true,
	...(r.outcome ? { outcome: r.outcome as "delivered" | "failed" } : {}),
	...(r.detail ? { detail: r.detail as string } : {}),
	...(r.finished_at ? { t: r.finished_at as string } : {}),
});

function claimItem(c: Db, source: string, claim: ClaimRecord): { won: boolean; claim: ClaimRecord } {
	return c.tx(() => {
		const id = itemId(c, source, claim.item);
		// Only the item's own row conflicts quietly. A delivery id already taken by another item is an error, never a lost claim.
		const r = c.run(
			"INSERT INTO claims (item_id, owner, delivery_id, message, claimed_at, answer, ruling, relay) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING",
			id,
			claim.owner,
			claim.deliveryId,
			claim.message,
			claim.t,
			json(claim.answer),
			json(claim.ruling),
			json(claim.relay),
		);
		if (r.changes === 1) return { won: true, claim };
		return {
			won: false,
			claim: toClaim(required(claimRow(c, source, claim.item), `claim for ${source}/${claim.item}`)),
		};
	});
}

export const makeClaims = (c: Db): Store["claims"] => ({
	claim: (source, claim) => claimItem(c, source, claim),
	get: (source, item) => {
		const r = claimRow(c, source, item);
		return r ? toClaim(r) : undefined;
	},
	release(source, item) {
		c.run("DELETE FROM claims WHERE item_id = (SELECT id FROM items WHERE source = ? AND dedup_key = ?)", source, item);
	},
	list: (source) =>
		c
			.all(
				"SELECT c.*, i.dedup_key AS item_key FROM claims c JOIN items i ON i.id = c.item_id WHERE i.source = ? ORDER BY c.item_id",
				source,
			)
			.map(toClaim),
	startRelay(source, item, t = new Date().toISOString()) {
		return (
			c.run(
				"INSERT INTO relays (item_id, started_at) VALUES (?, ?) ON CONFLICT (item_id) DO NOTHING",
				itemId(c, source, item),
				t,
			).changes === 1
		);
	},
	finishRelay(source, item, { outcome, detail, t = new Date().toISOString() }) {
		c.run(
			"UPDATE relays SET outcome = ?, detail = ?, finished_at = ? WHERE item_id = ?",
			outcome,
			detail ?? null,
			t,
			itemId(c, source, item),
		);
	},
	readRelay(source, item): RelayRecord {
		const r = c.one(
			"SELECT r.* FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ? AND i.dedup_key = ?",
			source,
			item,
		);
		return r ? toRelay(r) : { started: false };
	},
	listRelays: (source) =>
		new Map(
			c
				.all(
					"SELECT r.*, i.dedup_key AS item_key FROM relays r JOIN items i ON i.id = r.item_id WHERE i.source = ?",
					source,
				)
				.map((r) => [r.item_key as string, toRelay(r)]),
		),
});

const toEvidence = (r: Row): EvidenceRow => ({
	type: r.type as EvidenceRow["type"],
	...(r.name ? { name: r.name as string } : {}),
	...(r.url ? { url: r.url as string } : {}),
	...(r.caption ? { caption: r.caption as string } : {}),
});

function putEvidence(c: Db, source: string, item: string, rows: EvidenceRow[]): void {
	c.tx(() => {
		const id = itemId(c, source, item);
		c.run("DELETE FROM evidence WHERE item_id = ?", id);
		for (const [seq, e] of rows.entries())
			c.run(
				"INSERT INTO evidence (item_id, seq, type, name, url, caption) VALUES (?, ?, ?, ?, ?, ?)",
				id,
				seq,
				e.type,
				e.name ?? null,
				e.url ?? null,
				e.caption ?? null,
			);
	});
}

export const makeEvidence = (c: Db): Store["evidence"] => ({
	put: (source, item, rows) => putEvidence(c, source, item, rows),
	list: (source, item) =>
		c
			.all(
				"SELECT e.* FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? AND i.dedup_key = ? ORDER BY e.seq",
				source,
				item,
			)
			.map(toEvidence),
	listAll(source) {
		const out = new Map<string, EvidenceRow[]>();
		for (const r of c.all(
			"SELECT e.*, i.dedup_key AS item_key FROM evidence e JOIN items i ON i.id = e.item_id WHERE i.source = ? ORDER BY e.item_id, e.seq",
			source,
		))
			out.set(r.item_key as string, [...(out.get(r.item_key as string) ?? []), toEvidence(r)]);
		return out;
	},
});

// ---- state --------------------------------------------------------------------------------------
export function makeState(c: Db): Store["state"] {
	const state: Store["state"] = {
		get: <T>(key: string) => parse<T>(c.one("SELECT value FROM state WHERE key = ?", key)?.value),
		set(key, value) {
			c.run(
				"INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
				key,
				JSON.stringify(value),
				Date.now(),
			);
		},
		delete(key) {
			c.run("DELETE FROM state WHERE key = ?", key);
		},
		update: <T>(key: string, fn: (prior: T | undefined) => T | undefined) =>
			c.tx(() => {
				const next = fn(parse<T>(c.one("SELECT value FROM state WHERE key = ?", key)?.value));
				if (next === undefined) c.run("DELETE FROM state WHERE key = ?", key);
				else state.set(key, next);
				return next;
			}),
	};
	return state;
}

// ---- the sequence (migration 12) -------------------------------------------------------------------
export const makeSequence = (c: Db): Store["sequence"] => ({
	next: () =>
		c.tx(
			() =>
				required(c.one("UPDATE store_sequence SET value = value + 1 WHERE id = 1 RETURNING value"), "store sequence")
					.value as number,
		),
	current: () => required(c.one("SELECT value FROM store_sequence WHERE id = 1"), "store sequence").value as number,
});
