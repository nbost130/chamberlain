import type { ThreadKey } from "../../core/config/layout-schema.ts";
import { QuotaExhausted, type WakeTransport } from "../../core/delivery/deliver.ts";
import { configureThread, deskHasGatherer } from "./model.ts";

/**
 * Selection failure is a failed delivery, so the existing outbox retains its work. A desk run by a gatherer has no model selection at all
 * (configuredThreadModel refuses it), so its preflight passes: before 2026-11-17 it failed every time, and every Alert Desk wake was held
 * for good with nothing logged.
 */
export function modelWake(wake: WakeTransport, conf: string, role: ThreadKey): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string, target?: string) => {
			if (role === "desk" && deskHasGatherer(conf)) return true;
			try {
				if (!target) return false;
				await configureThread(conf, role, threadId, target);
			} catch (error) {
				if (error instanceof QuotaExhausted) throw error;
				return false;
			}
			return true;
		},
	});
}
