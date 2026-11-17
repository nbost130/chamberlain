/** Verify a wake against the selected server's authenticated scheduled-task snapshot. */
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

function bound(task: Task, origin: string, threadId: string, target: string): boolean {
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
	const url = new URL(target);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return false;
	// The authenticated server may advertise a relay URL. Local paths belong only to that server's origin.
	if (task.webhook.url && new URL(task.webhook.url).href === url.href) return true;
	const local = new URL(task.webhook.path, origin);
	return local.origin === new URL(origin).origin && local.href === url.href;
}

export async function verifyWebhook(rpc: Rpc, origin: string, threadId: string, target: string): Promise<void> {
	const value = await firstValue(rpc, "scheduledTasks.subscribe", {});
	const tasks = (value as { tasks?: Task[] })?.tasks;
	if (!Array.isArray(tasks) || !tasks.some((t) => bound(t, origin, threadId, target)))
		throw Error("webhook is not bound to the configured server and thread");
}
