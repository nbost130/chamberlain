/** Fixed diagnostics are the only text allowed out of preparation. Exception messages and causes never cross this boundary. */
export const PREFLIGHT_DETAILS = {
	busy: "The thread is active and its model selection cannot change yet.",
	quota: "The preferred provider exhausted its quota and no approved backup is eligible.",
	auth: "The server operate token or provider authentication is missing or refused.",
	unsupported: "The provider or model does not support the requested execution capability.",
	config: "Check the configured receiver, server, model selection and webhook binding.",
	unreachable: "The server connection closed, failed or timed out.",
	policy:
		"The desk's provider does not enforce its command allowlist. Use one that runs the hook, or reinstall the hook.",
	unknown: "An unrecognized failure prevented preparation.",
} as const;

export type PrepareReason = keyof typeof PREFLIGHT_DETAILS;
export const PREPARE_REASONS = Object.keys(PREFLIGHT_DETAILS) as PrepareReason[];
export type PrepareFailure = { ok: false; reason: PrepareReason; detail: string; retryAfterMs?: number };
export type PrepareResult = { ok: true } | PrepareFailure;

export const preparationFailed = (reason: PrepareReason): PrepareFailure => ({
	ok: false,
	reason,
	detail: PREFLIGHT_DETAILS[reason].slice(0, 120),
});

type Prepare = (threadId?: string, target?: string) => Promise<PrepareResult>;

/** Enforce the detail allowlist even if an adapter accidentally puts raw text in its result or throws. */
export async function prepareSafely(
	transport: { prepare?: Prepare },
	threadId?: string,
	target?: string,
): Promise<PrepareResult> {
	try {
		if (!transport.prepare) return { ok: true };
		const result = await transport.prepare(threadId, target);
		if (result.ok === true) return { ok: true };
		const reason = PREPARE_REASONS.includes(result.reason) ? result.reason : "unknown";
		const delay = result.retryAfterMs;
		return {
			...preparationFailed(reason),
			...(delay !== undefined && Number.isSafeInteger(delay) && delay >= 0 ? { retryAfterMs: delay } : {}),
		};
	} catch {
		return preparationFailed("unknown");
	}
}
