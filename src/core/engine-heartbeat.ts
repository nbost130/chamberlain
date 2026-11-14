/**
 * The heartbeat: once a minute, write the daemon's state for the page and turn a server that stays disconnected into an alarm. Split out of
 * createEngine (src/core/engine.ts), which passes it the few things it reads.
 */
import { readAfk } from "./afk-held.ts";
import { type AlarmText, alarms } from "./messages.ts";
import type { Store } from "./store.ts";

export type HeartbeatDeps = {
	store: Store;
	/** Each watcher's connection state. */
	watchers: readonly { health(): { name: string; connected: boolean; downMs: number } }[];
	/** How many wake deliveries have failed in a row, from the relay. */
	failures: () => number;
	/** Whether the named server is one that is often asleep (no alarm when it stays down). */
	mayBeOffline: (server: string) => boolean | undefined;
	raiseAlarm: (key: string, a: AlarmText) => void;
};

export function createHeartbeat({ store, watchers, failures, mayBeOffline, raiseAlarm }: HeartbeatDeps) {
	/** Once a minute: write the heartbeat file and turn silent stops into alarms. */
	function heartbeat() {
		const states = watchers.map((w) => w.health());
		store.state.set("heartbeat", {
			t: new Date().toISOString(),
			away: Boolean(readAfk(store)),
			deliveryFailures: failures(),
			servers: states,
		});
		for (const s of states)
			if (!s.connected && s.downMs > 10 * 60_000 && !mayBeOffline(s.name))
				raiseAlarm(`disconnected:${s.name}`, alarms.serverDown(s.name, Math.round(s.downMs / 60000)));
	}

	return { beat: heartbeat };
}
