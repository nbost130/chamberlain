import { thread } from "../../core/config/layout.ts";
import type { ThreadKey } from "../../core/config/layout-schema.ts";
import type { WakeTransport } from "../../core/delivery/deliver.ts";
import { type PrepareResult, preparationFailed } from "../../core/delivery/preflight.ts";
import { verifyDeskDriver } from "./desk-policy.ts";
import { configureThread, deskHasGatherer } from "./model.ts";
import { preflightFailure } from "./model-preflight.ts";

/**
 * Selection failure is a failed delivery, so the existing outbox retains its work. A desk run by a gatherer has no model selection at all
 * (configuredThreadModel refuses it), so none is made for it; its webhook and the driver of its next turn are verified instead. Either way a
 * desk wake needs `hooked`: proof that the project it runs in has the allowlist hook. It is read last, right before the send. What changes
 * between that read and the turn is caught by the audit (src/core/desk/desk-audit.ts). Without a proof the wake is held. `canCompact`, for
 * the compaction webhook, refuses as unsupported where the thread's provider is known not to compact.
 */
type Checks = {
	/** The desk's: does the project its turn runs in have the allowlist hook? Absent, a desk wake is held. */
	hooked?: (threadId: string | undefined) => boolean;
	/** The compaction webhook's: can the thread's provider compact? */
	canCompact?: (threadId: string) => boolean;
};

/** The preparation that can fail with a reason; a thrown error is turned into one by the caller. */
async function prepareOrThrow(
	{ conf, role, checks }: { conf: string; role: ThreadKey; checks: Checks },
	threadId: string | undefined,
	target: string,
): Promise<PrepareResult> {
	const desk = threadId ?? thread(conf, "desk");
	if (role === "desk" && deskHasGatherer(conf)) await verifyDeskDriver(conf, desk, target);
	else {
		const selected = await configureThread(conf, role, threadId, target);
		if (checks.canCompact && !checks.canCompact(selected.threadId)) return preparationFailed("unsupported");
	}
	if (role === "desk" && !(checks.hooked?.(desk) ?? false)) return preparationFailed("policy");
	return { ok: true };
}

export function modelWake(wake: WakeTransport, conf: string, role: ThreadKey, checks: Checks = {}): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string, target?: string): Promise<PrepareResult> => {
			if (!target) return preparationFailed("config");
			try {
				return await prepareOrThrow({ conf, role, checks }, threadId, target);
			} catch (error) {
				const failure = preflightFailure(error);
				// The compact relay treats an unsupported operation as a hand-off. An invalid
				// model option is a configuration refusal, not a compaction capability reading.
				return checks.canCompact && failure.reason === "unsupported" ? preparationFailed("config") : failure;
			}
		},
	});
}
