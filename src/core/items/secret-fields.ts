/**
 * A secret item's title, context, evidence and options must never appear where a non-secret item's would (API views,
 * Steward wakes, settled refusals, AFK briefs). One helper rewrites those fields to fixed stand-ins; every surface uses it.
 */
import type { Evidence, Option, Question } from "./questions.ts";

/** Stand-in title when a secret's real title must not leave its thread. */
export const SECRET_TITLE = "Secret request";
/** Stand-in context for the same (empty: the page already says secrets are entered in their thread). */
export const SECRET_CONTEXT = "";
/** Stand-in one-line hold/brief text: never the card's label. */
export const SECRET_HOLD_WHAT = "secret request";

type SecretFields = {
	secret?: boolean;
	title: string;
	context: string;
	evidence?: Evidence[];
	options: Option[];
	blocks?: string;
};

/** Pure: true when this item must never expose title, context, evidence or options outside its thread. */
export const isSecretItem = (q: Pick<Question, "secret">): boolean => q.secret === true;

/**
 * Pure: replace a secret item's title, context, evidence, options and blocks with fixed stand-ins. Non-secrets are
 * returned unchanged. Call at every surface that would otherwise show those fields where a non-secret's would appear.
 */
export function redactSecretFields<T extends SecretFields>(q: T): T {
	if (!isSecretItem(q)) return q;
	const { evidence: _evidence, blocks: _blocks, ...rest } = q;
	return { ...rest, title: SECRET_TITLE, context: SECRET_CONTEXT, options: [] } as unknown as T;
}

/** Pure: the hold/brief one-liner for a card. A secret never carries the card's label. */
export function secretSafeHoldWhat(secret: boolean, kindHold: string, label: string | undefined): string {
	if (secret) return SECRET_HOLD_WHAT;
	return label ? `${kindHold}: ${label}` : kindHold;
}
