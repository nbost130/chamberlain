/** What the Alert Desk's thread ran, as its backend recorded it (src/core/desk/desk-audit.ts replays it through the allowlist). */

/** One tool call that ran, in the words the allowlist hook uses. */
export type DeskCall = { tool: string; input: Record<string, unknown> };

export type DeskTurn = {
	id: string;
	/** When it finished. Turns are read in this order. */
	at: string;
	/** Every record the turn has, calls or not. None at all is a backend that records nothing. */
	items: number;
	ran: DeskCall[];
	/** Calls the hook refused, so they did not run. */
	refused: number;
	/** Records that do not say enough to replay. */
	unreadable: number;
};

/** `env` is the environment the installed allowlist runs with, so the replay applies the same rules. */
export type DeskTurns = { turns: DeskTurn[]; env: Record<string, string> };
/** The turns that finished after `after` and no later than `until`, oldest first, at most `limit`. Undefined when they cannot be read. */
export type ReadDeskTurns = (span: {
	after: { at: string; id: string };
	until: string;
	limit: number;
}) => DeskTurns | undefined;
