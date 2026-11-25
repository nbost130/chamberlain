/** What the Alert Desk's thread ran, as its backend recorded it (src/core/desk/desk-audit.ts replays it through the allowlist). */

/** One tool call that ran, in the words the allowlist hook uses. */
export type DeskCall = { tool: string; input: Record<string, unknown> };

/** A finished turn: when it finished, how many records it has, and a mark (`rev`) that differs once a record is added or changed. */
export type DeskTurnRef = { id: string; at: string; items: number; rev: string };

export type DeskTurn = {
	ran: DeskCall[];
	/** Calls the hook refused, so they did not run. */
	refused: number;
	/** Records that may be calls and do not say enough to replay. */
	unreadable: number;
};

export type DeskTurns = {
	/** The turns that finished after `after` and no later than `until`, oldest first, at most `limit`. Undefined when they cannot be read. */
	list(span: { after: string; until: string; limit: number }): DeskTurnRef[] | undefined;
	read(ref: DeskTurnRef): DeskTurn | undefined;
	/** The environment the installed allowlist runs with, so the replay applies the same rules. */
	env(): Record<string, string>;
};
