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
 * between that read and the turn is caught by the audit (src/core/desk/desk-audit.ts). Without a proof the wake is held.
 */
export function modelWake(
	wake: WakeTransport,
	conf: string,
	role: ThreadKey,
	hooked: (threadId: string | undefined) => boolean = () => false,
): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string, target?: string): Promise<PrepareResult> => {
			try {
				if (!target) return preparationFailed("config");
				const desk = threadId ?? thread(conf, "desk");
				if (role === "desk" && deskHasGatherer(conf)) await verifyDeskDriver(conf, desk, target);
				else await configureThread(conf, role, threadId, target);
				if (role === "desk" && !hooked(desk)) return preparationFailed("policy");
			} catch (error) {
				return preflightFailure(error);
			}
			return { ok: true };
		},
	});
}
