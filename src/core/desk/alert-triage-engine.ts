/** Engine branch for the alert desk / triage drain. Keeps engine-core-work under the line budget. */

import type { Outbox } from "../delivery/deliver.ts";
import type { Store } from "../store/store.ts";
import { drainAlertDesk } from "./alert-desk.ts";
import { inboxPath } from "./alert-desk-config.ts";
import { drainTriage } from "./alert-triage.ts";
import { readTriageConfig } from "./alert-triage-config.ts";

export type DeskDrainHost = {
	store: Store;
	outbox: Outbox;
	conf: string;
	DRY: boolean;
	deskLane?: { wake: { ready: () => boolean } };
	log: (event: string, data?: Record<string, unknown>) => void;
	alarm: (key: string, title: string, summary: string) => void;
	clearAlarm: (key: string) => void;
	now: () => number;
};

export function drainDeskPass(h: DeskDrainHost): void {
	const triage = readTriageConfig(h.conf);
	if (!triage.enabled) {
		if (!h.deskLane) return;
		try {
			drainAlertDesk({
				store: h.store,
				outbox: h.outbox,
				inbox: inboxPath(process.env, process.env.HOME ?? ""),
				conf: h.conf,
				now: h.now(),
				canDeliver: !h.DRY && h.deskLane.wake.ready(),
				log: h.log,
			});
		} catch (e) {
			h.log("alert-desk-error", { error: String(e).slice(0, 200) });
			h.alarm(
				"alert-desk",
				"chamberlain alert desk failed",
				"The Alert Desk drain threw an error and did not finish, so alerts are not reaching the desk thread this round. Its inbox keeps them.",
			);
		}
		return;
	}
	if (h.DRY) {
		h.log("alert-triage-dry");
		return;
	}
	if (!h.deskLane) {
		h.alarm(
			"alert-triage-no-desk",
			"alert triage has no desk lane",
			"alertTriage is enabled but no desk receiver is configured; nothing was read.",
		);
		return;
	}
	try {
		drainTriage({
			store: h.store,
			outbox: h.outbox,
			inbox: inboxPath(process.env, process.env.HOME ?? ""),
			conf: h.conf,
			now: h.now(),
			log: h.log,
			alarm: h.alarm,
			clearAlarm: h.clearAlarm,
		});
	} catch (e) {
		h.log("alert-triage-error", { error: String(e).slice(0, 200) });
		h.alarm(
			"alert-triage",
			"chamberlain alert triage failed",
			"The alert triage pass threw an error and did not finish. Its inbox keeps the unread lines.",
		);
	}
}
