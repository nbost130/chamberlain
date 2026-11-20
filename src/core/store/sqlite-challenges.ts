/** The confirmation challenges: single-use, expiring confirmations for one approval, bound to its card fingerprint, the decision and the session. */

import type { Db } from "./sqlite-db.ts";
import type { Store } from "./store.ts";
import type { Challenge, ChallengeVerdict } from "./store-wakes.ts";

// ---- confirmation challenges --------------------------------------------------------------------
function issueChallenge(c: Db, ch: Challenge): void {
	c.tx(() => {
		c.run(
			"DELETE FROM confirmation_challenges WHERE card_id = ? AND session_hash = ? AND consumed_at IS NULL",
			ch.cardId,
			ch.sessionHash,
		);
		c.run(
			"INSERT INTO confirmation_challenges (token_hash, card_id, sig, choice, session_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			ch.tokenHash,
			ch.cardId,
			ch.sig,
			ch.choice,
			ch.sessionHash,
			ch.issuedAt,
			ch.expiresAt,
		);
	});
}

function consumeChallenge(
	c: Db,
	tokenHash: string,
	expect: { cardId: string; sig: string; choice: number; sessionHash: string },
	now: number,
): ChallengeVerdict {
	return c.tx(() => {
		const r = c.one("SELECT * FROM confirmation_challenges WHERE token_hash = ?", tokenHash);
		if (!r) return "unknown";
		if (r.consumed_at !== null) return "used";
		if ((r.expires_at as number) <= now) return "expired";
		if (
			r.card_id !== expect.cardId ||
			r.sig !== expect.sig ||
			r.choice !== expect.choice ||
			r.session_hash !== expect.sessionHash
		)
			return "mismatch";
		c.run(
			"UPDATE confirmation_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
			now,
			tokenHash,
		);
		return "ok";
	});
}

export const makeChallenges = (c: Db): Store["challenges"] => ({
	issue: (ch) => issueChallenge(c, ch),
	consume: (tokenHash, expect, now) => consumeChallenge(c, tokenHash, expect, now),
	prune: (before) =>
		c.run(
			"DELETE FROM confirmation_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)",
			before,
			before,
		).changes,
});
