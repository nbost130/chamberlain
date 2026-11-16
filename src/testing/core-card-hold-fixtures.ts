import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { WaitingItem } from "../core/adapter/adapter-waiting.ts";
import { questionStates } from "../core/items/questions.ts";
import { heldOpen } from "../core/ops/afk-held.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import type { memStore } from "./store.ts";

export const AT = { thread: "Deploy pipeline", server: "main", threadId: "th-1" };

const SENTINEL = "plain-SENTINEL-text-never-shown";

export const secretCard: WaitingItem = {
	type: "secret_request",
	requestId: "req-s1",
	label: "STRIPE_KEY",
	questions: [{ question: `paste it: ${SENTINEL}`, options: [{ label: SENTINEL, description: SENTINEL }] }],
};

export const approval: WaitingItem = {
	type: "approval_request",
	requestId: "req-a1",
	label: "bun run deploy",
	questions: [{ question: "run it?" }],
};

export const fileStore = () => {
	const dir = mkdtempSync(`${tmpdir()}/chamberlain-cardrec-`);
	return { path: `${dir}/chamberlain.db`, open: () => openStore(`${dir}/chamberlain.db`) };
};

/** A read that saw these request IDs waiting and these resolved. */
export const saw =
	(waiting: string[] = [], resolved: string[] = []) =>
	async () => ({ ok: true as const, waiting: new Set(waiting), resolved: new Set(resolved) });

export const open = (store: ReturnType<typeof memStore>) => ({
	holds: heldOpen(store).length,
	questions: [...questionStates(store).values()].filter((q) => q.status === "open").length,
});
