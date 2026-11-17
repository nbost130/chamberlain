import type { ThreadKey } from "../../core/config/layout-schema.ts";
import type { WakeTransport } from "../../core/delivery/deliver.ts";
import { configureThread } from "./model.ts";

/** Selection failure is a failed delivery, so the existing outbox retains its work. */
export function modelWake(wake: WakeTransport, conf: string, role: ThreadKey): WakeTransport {
	return Object.assign(wake, {
		prepare: async (threadId?: string) => {
			try {
				await configureThread(conf, role, threadId);
			} catch {
				return false;
			}
			return true;
		},
	});
}
