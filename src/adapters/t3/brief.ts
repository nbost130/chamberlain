/** The sentences of the Steward's hand-off that are about T3 (BriefNotes, src/core/adapter.ts): its tools, and the helpers that read it. */
import type { BriefNotes } from "../../core/adapter.ts";
import { selfCommand } from "../../core/config.ts";

export const t3Brief = ({ repo }: { repo: string }): BriefNotes => ({
	threads: "T3 threads",
	server: "T3 server",
	readThread: `read the end of the thread with \`${selfCommand("peek", { repo })} <server> <threadId> [messages] [chars]\`, about a tenth of what \`t3_thread_read\` costs`,
	contextExtras:
		"Use the `activity` view only when a decision depends on it, and list scheduled tasks only during a hand-over.",
	cardGuard: ", so `t3_pending_request` stays off it.",
	reachIntro: "The ordinary `t3_*` tools act on every machine:",
	reachOutro: `\`${selfCommand("t3x", { repo })} threads|read|respond|send <server> ...\` is a fallback command line for a server those tools cannot reach.`,
});
