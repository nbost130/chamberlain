import type { ThreadKey } from "../../core/config/layout-schema.ts";
import type { WakeTransport } from "../../core/delivery/deliver.ts";
import { type PrepareResult, preparationFailed } from "../../core/delivery/preflight.ts";
import { configureThread, deskHasGatherer } from "./model.ts";
import { preflightFailure } from "./model-preflight.ts";

/**
 * Selection failure is a failed delivery, so the existing outbox retains its work. A desk run by a gatherer has no model selection at all
 * (configuredThreadModel refuses it), so its preflight passes: before 2026-11-17 it failed every time, and every Alert Desk wake was held
 * for good with nothing logged.
 */
export function modelWake(
	wake: WakeTransport,
	conf: string,
	role: ThreadKey,
	canCompact?: (threadId: string) => boolean,
): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string, target?: string): Promise<PrepareResult> => {
			try {
				if (role === "desk" && deskHasGatherer(conf)) return { ok: true };
				if (!target) return preparationFailed("config");
				const selected = await configureThread(conf, role, threadId, target);
				if (canCompact && !canCompact(selected.threadId)) return preparationFailed("unsupported");
			} catch (error) {
				const failure = preflightFailure(error);
				// The compact relay treats an unsupported operation as a hand-off. An invalid
				// model option is a configuration refusal, not a compaction capability reading.
				return canCompact && failure.reason === "unsupported" ? preparationFailed("config") : failure;
			}
			return { ok: true };
		},
	});
}
