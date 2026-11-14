import { type El, run, settle } from "./inline-dom.ts";

export const card = (prompt: string, sig: string) => ({
	id: "C-0123456789ab",
	type: "approval",
	server: "main",
	threadId: "t",
	threadTitle: "T",
	requestId: "a1",
	header: "Approval",
	question: "command",
	command: prompt,
	options: [{ label: "Approve once" }, { label: "Decline" }],
	answerable: true,
	sig,
});

export const item = (context: string) => ({
	id: "Q-ctx1",
	kind: "product",
	title: "T",
	context,
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	status: "open",
	createdAt: new Date().toISOString(),
});

export async function ctxOf(context: string) {
	const dq = run(() => ({ items: [item(context)] }));
	await settle();
	return dq;
}

// ---- what the inline view asks the server for (the server allows no more: inlineVerdict in app.ts) ----

export const INLINE_PATHS = new Set(["/api/queue", "/api/recent", "/api/rulings"]);

// ---- links out of the view: T3 Code's frame opens only http(s), so each one is the page's own address, signed with ?k= ----

/** The text of every button on the screen: Snooze, Direction and Dismiss act in place now (inline-act.test.ts), so they are buttons, never links. */
export const buttons = (dq: El) =>
	dq.all((e) => e.tag === "button" && e.className.includes("dq-btn")).map((b) => b.textContent);
