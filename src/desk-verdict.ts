/** The Alert Desk allowlist's answer to a command: allowed, or refused with the reason. The leaf the allowlist's modules share. */
export type Verdict = { ok: true } | { ok: false; reason: string };
export const ok: Verdict = { ok: true };
export const no = (reason: string): Verdict => ({ ok: false, reason });
