import { expect, test } from "bun:test";
import { overheadSettings } from "../../core/overhead/settings.ts";
import { openStore } from "../../core/store/sqlite-store.ts";
import { modelServer } from "../../testing/model-server.ts";
import { testRelay } from "../../testing/relay.ts";
import { launchSelection } from "./launch-selection.ts";
import { configureThread } from "./model.ts";
import { modelWake } from "./model-wake.ts";
import { webhookWake } from "./wake.ts";

test("Steward drains the same 67 wakes after quota exhaustion and relay restart", async () => {
	const server = modelServer();
	const db = `${server.conf}/queue.db`;
	let store = openStore(db);
	const alerts: string[] = [];
	const url = `${server.config.servers[0]!.origin}/wake`;
	const wake = modelWake(
		webhookWake(() => url),
		server.conf,
		"steward",
	);
	const id = "active-generation";
	const relay = () =>
		testRelay(store, wake, {
			genSnapshot: () => ({ gen: 1, thread: id, wakeRef: "wake-url", wakeUrl: url }),
			alarm: (key) => {
				if (store.items.observe({ source: "alarm", kind: "alarm", dedupKey: key }).notify) alerts.push(key);
			},
		}).relay;
	try {
		store.steward.insertGen({ gen: 1, thread: id, wakeRef: "wake-url", createdAt: Date.now() });
		server.bindWake(url, id);
		const backup = { instanceId: "backup", model: "backup-model" };
		Object.assign(server.config.models.steward, { fallbacks: [{ ...backup, instanceId: "missing" }, backup] });
		server.save();
		expect(overheadSettings(server.conf).model).toBeUndefined();
		server.state.exhausted = true;
		const ids = Array.from({ length: 67 }, (_, n) => `incident-${n}`);
		for (const deliveryId of ids) store.wakes.enqueue({ deliveryId, message: "wake", queuedAt: Date.now() });
		await relay().pass();
		expect(alerts).toEqual(["model-quota"]);
		expect(store.wakes.rows().every((row) => row.attempts === 0)).toBe(true);
		store.close();
		store = openStore(db);
		const restarted = relay();
		await restarted.pass();
		expect(alerts).toHaveLength(1);
		server.state.backupAvailable = true;
		expect((await launchSelection(server.conf, "steward")).launch.modelSelection.instanceId).toBe("backup");
		await expect(launchSelection(server.conf, "desk")).rejects.toThrow();
		server.state.startDuringCatalog = true;
		await restarted.pass();
		expect(server.posts).toHaveLength(0);
		expect(server.selection().instanceId).toBe("old");
		server.state.startDuringCatalog = false;
		server.state.busy = false;
		await wake.prepare!(id, url);
		// Restart between preparation and dispatch with the active generation already on the backup.
		store.close();
		store = openStore(db);
		const recovered = relay();
		for (let pass = 0; pass < ids.length && store.wakes.rows().length; pass++) await recovered.pass();
		expect(server.posts.map((body) => JSON.parse(body).deliveryId)).toEqual(ids);
		expect(store.items.get("alarm", "model-quota")?.status).toBe("resolved");
		expect(store.wakes.rows()).toHaveLength(0);
		expect(
			server.requests.filter((r) => r.payload.type === "thread.model-selection.set").map((r) => r.payload.threadId),
		).toEqual([id]);
		server.state.exhausted = false;
		expect((await configureThread(server.conf, "steward")).modelSelection.instanceId).toBe(server.state.instanceId);
		server.state.unauthenticated = true;
		await expect(configureThread(server.conf, "steward")).rejects.toThrow("authentication");
		server.state.unauthenticated = false;
		server.state.exhausted = true;
		server.state.backupAvailable = false;
		store.wakes.enqueue({ deliveryId: "later-outage", message: "wake", queuedAt: Date.now() });
		await recovered.pass();
		expect(alerts).toHaveLength(2);
		server.state.backupAvailable = true;
		await recovered.pass();
		expect(server.selection().instanceId).toBe("backup");
		expect(JSON.parse(server.posts.at(-1)!).deliveryId).toBe("later-outage");
	} finally {
		store.close();
		server.close();
	}
});
