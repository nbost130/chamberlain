/**
 * A secret item's title, context, evidence and options must never appear where a non-secret item's would (API views,
 * Steward wakes, settled refusals, AFK briefs, mirrored cards). One helper rewrites those fields to fixed stand-ins;
 * every surface uses it.
 */
import type { Evidence, Option, Question } from "./questions.ts";

/** Stand-in title when a secret's real title must not leave its thread. */
export const SECRET_TITLE = "Secret request";
/** Stand-in context for the same (empty: the page already says secrets are entered in their thread). */
const SECRET_CONTEXT = "";
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

/** A mirrored waiting card as the page shows it: a secret's `question` holds the source card's label/reason. */
type SecretCard = {
	type: string;
	question: string;
	header?: string;
	options: unknown[];
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

/**
 * Pure: a mirrored secret card never carries the source card's label or reason in `question` (or options). Other kinds
 * are unchanged. Used by cardView and by the T3 adapter when building the mirror.
 */
export function redactSecretCard<T extends SecretCard>(c: T): T {
	if (c.type !== "secret") return c;
	return { ...c, question: SECRET_TITLE, header: c.header ?? SECRET_TITLE, options: [] };
}

/** Pure: the hold/brief one-liner for a card. A secret never carries the card's label. */
export function secretSafeHoldWhat(secret: boolean, kindHold: string, label: string | undefined): string {
	if (secret) return SECRET_HOLD_WHAT;
	return label ? `${kindHold}: ${label}` : kindHold;
}

/**
 * Pure: scrub a stored wake's `question:` line to the stand-in title. Used when a pre-upgrade claim or held row still
 * carries a secret's real title and the answer cannot be re-derived.
 */
export function scrubSecretQuestionLine(message: string): string {
	return message.replace(/^question:.*$/m, `question: ${SECRET_TITLE}`);
}
