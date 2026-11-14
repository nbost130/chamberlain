/**
 * The T3 Code adapter: everything Chamberlain knows about T3 lives in this folder. It watches T3's shell stream with a
 * read-only token, wakes the Steward through a webhook bound to its thread, reads whether the Steward is busy from T3's
 * state database (read-only), posts questions to the Decisions thread with the T3 CLI, and, where the page has been
 * granted an operate token, answers cards and renames the Decisions thread through T3's own commands.
 */
import type { Adapter, AdapterEntry, AdapterEnv, AdapterFactory, OptionalCapability } from "../../core/adapter.ts";
import type { Gate } from "../../core/hold.ts";
import { setting } from "../../core/layout.ts";
import type { ServerEntry } from "../../core/servers.ts";
import { t3Brief } from "./brief.ts";
import { t3Linker } from "./links.ts";
import { postCard } from "./post.ts";
import { queueGate, readStewardQueue } from "./queue.ts";
import { t3Server } from "./server.ts";
import { t3StateDbPath } from "./settings.ts";
import { t3Probe } from "./steward.ts";
import { t3TitleSetter } from "./title.ts";
import { t3Transcript } from "./transcript.ts";
import { createT3Waiting } from "./waiting.ts";
import { webhookWake } from "./wake.ts";
import { T3Link } from "./watch.ts";

/** The wake's server line: how the woken thread reaches this server with the ordinary t3_* tools. */
export const t3ServerLine = (srv: { name: string; environmentId?: string }): string =>
	srv.environmentId
		? `server: ${srv.name} (linked: pass environmentId ${srv.environmentId} to the t3_* tools)`
		: `server: ${srv.name} (this server)`;

/** The server a wake says it is about when there is no servers.json: one T3 server named "local". */
export const defaultT3Server = (): ServerEntry => ({
	name: "local",
	adapter: "t3",
	origin: setting("t3Origin") ?? "http://127.0.0.1:3773",
	tokenFile: "read-token",
});

/** Every optional capability the T3 adapter implements. */
const T3_CAPABILITIES: readonly OptionalCapability[] = [
	"answer",
	"listWaiting",
	"setTitle",
	"transcriptPath",
	"inspect",
	"send",
	"stewardProbe",
	"compact",
	"snapshot",
	"alertDesk",
	"handoffInstruction",
	"threadLinks",
];

/** Idle when no thread id is known yet; otherwise what the thread's queue in T3's state database says. */
const threadGate = (id: string | undefined): Gate => (id ? queueGate(readStewardQueue(t3StateDbPath(), id)) : "idle");

export const createT3Adapter: AdapterFactory = (env: AdapterEnv): Adapter => {
	const srv = t3Server(env.server);
	const link = new T3Link(env, srv);
	const linker = t3Linker(srv);
	const waiting = createT3Waiting({ server: srv, conf: env.conf, log: env.log, linker });
	const wake = webhookWake(() => env.readPrivate("wake-url"));
	const compactWake = webhookWake(() => env.readPrivate("compact-url"));
	const isBusy = (): Gate => threadGate(env.steward());
	return {
		id: "t3",
		capabilities: [...T3_CAPABILITIES],
		watch: (sink, signal) => link.watch(sink, signal),
		wake,
		isBusy,
		post: async (item, opts) => postCard(item, env.conf, opts.queueUrl, opts.capability),
		answer: waiting.answer,
		listWaiting: waiting.listWaiting,
		// The rename needs the operate token the page grants (web.json) and the Decisions thread's id; without either it reports why.
		setTitle: async (title) => {
			const thread = env.readPrivate("decisions-thread");
			if (!thread || !srv.operateTokenFile) return "no-token";
			return t3TitleSetter(env.conf, srv.origin, srv.operateTokenFile, thread)(title);
		},
		transcriptPath: () => t3Transcript({ dbPath: t3StateDbPath(), conf: env.conf }),
		inspect: link.inspector,
		snapshot: () => link.snapshot(),
		send: waiting.send,
		stewardProbe: () => {
			const id = env.steward();
			return id ? t3Probe(t3StateDbPath(), id) : { readable: true };
		},
		compact: compactWake,
		handoffInstruction: () =>
			"Run /steward-handoff now: rebuild the brief, start the fresh Steward thread and retire this one.",
		// The Alert Desk's own webhook and thread (desk-wake-url, desk-thread), made by the operator. Without the URL nothing is drained.
		alertDesk: {
			wake: webhookWake(() => env.readPrivate("desk-wake-url")),
			isBusy: (): Gate => threadGate(env.readPrivate("desk-thread")),
		},
		threadLinks: (threadId) => linker.links(threadId),
		serverLine: () => t3ServerLine(srv),
		approvalHint: "The t3_pending_request tool cannot answer it.",
	};
};

/** The registry entry: how to make the adapter, and the lines of the Steward's hand-off that name T3's tools. */
export const t3Entry: AdapterEntry = {
	create: createT3Adapter,
	brief: t3Brief,
};
