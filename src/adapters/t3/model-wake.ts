import { thread } from "../../core/config/layout.ts";
import type { ThreadKey } from "../../core/config/layout-schema.ts";
import type { WakeTransport } from "../../core/delivery/deliver.ts";
import { type PrepareResult, preparationFailed } from "../../core/delivery/preflight.ts";
import { configureThread, deskHasGatherer } from "./model.ts";
import { preflightFailure } from "./model-preflight.ts";

/**
 * Selection failure is a failed delivery, so the existing outbox retains its work. A desk run by a gatherer has no model selection at all
 * (configuredThreadModel refuses it), so none is made for it. Either way a desk wake needs `enforced`: proof that the desk's next turn runs
 * where its command allowlist is enforced. It is read last, right before the send, so it sees the selection just made. What changes between
 * that read and the turn is caught by the audit (src/core/desk/desk-audit.ts). Without a proof the wake is held.
 */
export function modelWake(
	wake: WakeTransport,
	conf: string,
	role: ThreadKey,
	enforced: (threadId: string | undefined) => boolean = () => false,
): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string, target?: string): Promise<PrepareResult> => {
			try {
				if (role !== "desk" || !deskHasGatherer(conf)) {
					if (!target) return preparationFailed("config");
					await configureThread(conf, role, threadId, target);
				}
				if (role === "desk" && !enforced(threadId ?? thread(conf, "desk"))) return preparationFailed("policy");
			} catch (error) {
				return preflightFailure(error);
			}
			return { ok: true };
		},
	});
}
