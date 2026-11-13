/**
 * The server-side confirmation step for approvals and goal proposals. A command approval is the one answer the page makes that
 * cannot be taken back, so the "tap again to confirm" lives here, not in the page's script: a request that did not first obtain a
 * challenge is refused, whatever its client.
 *
 *   step one  `issueChallenge`: the card, the fingerprint the operator saw, the decision chosen and the session. The reply carries a
 *             random single-use token that expires in 60 seconds.
 *   step two  `consumeChallenge`: the answer must present that token for exactly that card, fingerprint, decision and session. It is
 *             consumed by the check, so a replay is refused; an expired, unknown or mismatched one is refused.
 *
 * The session is a random value the page's server sets in an HttpOnly, SameSite=Strict cookie the first time it is needed. Tokens
 * and session values are random (192 bits); the database keeps only their SHA-256 hashes.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ChallengeVerdict, Store } from "./store.ts";

export const CHALLENGE_TTL_MS = 60_000;
export const SESSION_COOKIE = "dq_session";
const SESSION_FORMAT = /^[a-f0-9]{48}$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const newSession = (): string => randomBytes(24).toString("hex");
/** The session in a Cookie header, if it is well formed. */
export const sessionOf = (cookie: string | null): string | undefined => {
	for (const part of (cookie ?? "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === SESSION_COOKIE) { const val = v.join("="); if (SESSION_FORMAT.test(val)) return val; } }
	return undefined;
};

export type ChallengeFor = { cardId: string; sig: string; choice: number; session: string; now?: number };
/** Issues a challenge. The token is returned once and never stored; an earlier unconsumed challenge of this session for the card is replaced. */
export function issueChallenge(store: Store, o: ChallengeFor): { token: string; expiresAt: number } {
	const now = o.now ?? Date.now();
	const token = randomBytes(24).toString("hex");
	const expiresAt = now + CHALLENGE_TTL_MS;
	store.challenges.issue({ tokenHash: sha(token), cardId: o.cardId, sig: o.sig, choice: o.choice, sessionHash: sha(o.session), issuedAt: now, expiresAt });
	return { token, expiresAt };
}
/** Consumes a challenge for exactly this card, fingerprint, choice and session. Only "ok" lets the answer through. */
export function consumeChallenge(store: Store, o: ChallengeFor & { token: unknown }): ChallengeVerdict {
	if (typeof o.token !== "string" || !/^[a-f0-9]{48}$/.test(o.token)) return "unknown";
	return store.challenges.consume(sha(o.token), { cardId: o.cardId, sig: o.sig, choice: o.choice, sessionHash: sha(o.session) }, o.now ?? Date.now());
}
