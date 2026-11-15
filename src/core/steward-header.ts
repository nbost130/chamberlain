/**
 * Transfer-item headers. Adoption (gen 0) is labelled as historical recovery with an unknown prior destination;
 * never present generation 0 as a known previous Steward. Old actions need current-state validation and decision rights.
 * "Once" means one transfer item created, not one HTTP delivery.
 */

export type TransferHeaderInput = {
	rootId: string;
	/** Generation the original delivery was ledgered under. 0 = adoption / unknown prior destination. */
	fromGen: number;
	/** Thread of fromGen when fromGen >= 1; ignored for gen 0. */
	fromThread?: string;
	/** Original outbox row creation time (epoch ms). */
	createdAt: number;
	/** True when this item comes from adoption of a pre-upgrade row. */
	adoption?: boolean;
	/** True when the original action may already have been resolved (caller hint for the Steward). */
	mayBeResolved?: boolean;
};

/** Header lines placed above the frozen original message on a transfer item. */
export function transferHeader(o: TransferHeaderInput): string {
	const when = new Date(o.createdAt).toISOString();
	if (o.fromGen === 0 || o.adoption) {
		return [
			`Historical recovery (adoption). Original delivery id (root): ${o.rootId}.`,
			`Original creation time: ${when}.`,
			"Prior Steward destination: unknown (generation 0 — not a known previous Steward).",
			"This may be a repeat or already resolved: search this thread for the original id, validate against live state under the current decision rights, then act.",
			"Creating this transfer item once does not mean one HTTP delivery; transport retries and later switches can still duplicate.",
		].join("\n");
	}
	return [
		`Original delivery id: ${o.rootId}. Previous Steward thread: ${o.fromThread ?? "(unknown)"}.`,
		`Original creation time: ${when}.`,
		"This may be a repeat: search this thread for the original id, check live state under the current decision rights, then act.",
		"Creating this transfer item once does not mean one HTTP delivery; transport retries and later switches can still duplicate.",
		...(o.mayBeResolved
			? [
					"The original action may already have been resolved; require current-state validation before any external effect.",
				]
			: []),
	].join("\n");
}

/** Full transfer-item message: header, blank line, frozen original body. */
export const transferMessage = (header: TransferHeaderInput, frozen: string): string =>
	`${transferHeader(header)}\n\n${frozen}`;
