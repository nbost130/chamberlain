import type { Inspector } from "../adapter/adapter-inspect.ts";

/** A fresh successful run supersedes old failure notifications, irrespective of provider. */
export async function failureFreshness(
	inspect: Inspector | undefined,
	threadId: string,
): Promise<"send" | "wait" | "cancel"> {
	if (!inspect?.look) return "send";
	try {
		const current = await inspect.look(threadId);
		if (!current) return "send";
		if (current.active || current.waiting) return "wait";
		if (["completed", "idle"].includes(current.latestStatus ?? "")) return "cancel";
		return current.latestStatus === "failed" ? "send" : "wait";
	} catch {
		return "wait";
	}
}
