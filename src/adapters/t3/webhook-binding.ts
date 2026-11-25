/** Verify a wake against the selected server's authenticated scheduled-task snapshot. */
import { ModelPreparationError } from "./model-preflight.ts";
import type { Rpc } from "./rpc.ts";
import { firstValue } from "./rpc-first.ts";

type Task = {
	enabled: boolean;
	threadId: string | null;
	threadMode?: string;
	schedule: { type: string };
	blockedByPolicy?: string;
	webhook?: { path: string; url: string | null; hasSecret?: boolean };
};

function bound(task: Task, origin: string, threadId: string, url: URL): boolean {
	if (
		!task.enabled ||
		task.blockedByPolicy ||
		task.threadId !== threadId ||
		(task.threadMode !== undefined && !["continue", "fresh_session"].includes(task.threadMode)) ||
		task.schedule?.type !== "webhook" ||
		!task.webhook ||
		task.webhook.hasSecret
	)
		return false;
	// The authenticated server may advertise a relay URL. Local paths belong only to that server's origin.
	if (task.webhook.url && URL.parse(task.webhook.url)?.href === url.href) return true;
	const local = URL.parse(task.webhook.path, origin);
	return local?.origin === new URL(origin).origin && local.href === url.href;
}

export async function verifyWebhook(rpc: Rpc, origin: string, threadId: string, target: string): Promise<void> {
	const url = URL.parse(target);
	const mismatch = () =>
		new ModelPreparationError("config", "webhook is not bound to the configured server and thread");
	if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw mismatch();
	const value = await firstValue(rpc, "scheduledTasks.subscribe", {});
	const tasks = (value as { tasks?: Task[] })?.tasks;
	if (!Array.isArray(tasks)) throw Error("scheduled-task snapshot unavailable");
	if (!tasks.some((t) => bound(t, origin, threadId, url))) throw mismatch();
}
