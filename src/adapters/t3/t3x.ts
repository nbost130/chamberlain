/**
 * t3x: act on a thread on any configured T3 server, for the case the t3_* MCP tools can't reach one. Servers come from
 * the `servers` list of ~/.config/chamberlain/config.json; an optional `operateTokenFile` (orchestration:operate) enables respond/send.
 * Tokens are never printed.
 *
 *   bun src/adapters/t3/t3x.ts threads <server>
 *   bun src/adapters/t3/t3x.ts read    <server> <threadId>
 *   bun src/adapters/t3/t3x.ts respond <server> <threadId> "<question header>=<option label>" ...
 *   bun src/adapters/t3/t3x.ts send    <server> <threadId> <text>
 */

import { CONF } from "../../core/config.ts";
import { readSecret } from "../../core/layout.ts";
import { startup } from "../../core/migrate.ts";
import { readServers } from "../../core/servers.ts";
import { activeRunOf, messageCommand } from "./ping.ts";
import { connect, type Rpc } from "./rpc.ts";
import { type T3Server, t3Server } from "./server.ts";

type Server = T3Server;
type Option = { label?: string; description?: string };
type Question = { id: string; header: string; question?: string; options?: Option[] };
type TurnItem = { type?: string; status?: string; text?: unknown; requestId: string; questions?: Question[] };
type Projection = { turnItems?: TurnItem[]; runs?: { id?: string; status?: string }[] };
type ShellThread = {
	status?: unknown;
	id?: unknown;
	title?: unknown;
	pendingRuntimeRequest?: unknown;
	snoozedUntil?: unknown;
	settledAt?: unknown;
	archivedAt?: unknown;
	lineage?: { parentThreadId?: unknown } | null;
};

function priv(name: string): string {
	const v = readSecret(CONF, name);
	if (!v) throw Error(`${name}: no such secret (looked in ${CONF}/secrets/ and the config directory)`);
	return v;
}

const projection = async (rpc: Rpc, threadId: string | undefined) =>
	(await rpc.request("orchestration.getThreadProjection", { threadId })) as Projection;
const waitingRequests = (p: Projection): TurnItem[] =>
	(p.turnItems ?? []).filter((i) => i.type === "user_input_request" && i.status === "waiting");

/** The one line `threads` prints for a thread, or undefined for a thread that is settled, archived or a child. */
function threadLine(x: ShellThread): string | undefined {
	if (x.settledAt || x.archivedAt || x.lineage?.parentThreadId) return undefined;
	return [
		x.status,
		x.id,
		JSON.stringify(x.title),
		x.pendingRuntimeRequest ? "PENDING" : "",
		x.snoozedUntil ? "snoozed" : "",
	]
		.filter(Boolean)
		.join(" | ");
}

async function listThreads(srv: Server) {
	const rpc = await connect(srv.origin, priv(srv.tokenFile));
	await new Promise<void>((resolve) => {
		rpc
			.call("orchestration.subscribeShell", {}, (v) => {
				if (v.kind !== "snapshot") return;
				for (const x of v.snapshot.threads ?? []) {
					const line = threadLine(x);
					if (line !== undefined) console.log(line);
				}
				resolve();
			})
			.catch(() => resolve());
	});
	return rpc.ws.close();
}

async function readThread(srv: Server, threadId: string) {
	const rpc = await connect(srv.origin, priv(srv.tokenFile));
	const p = await projection(rpc, threadId);
	const last = [...(p.turnItems ?? [])]
		.reverse()
		.filter((i) => i.type === "assistant_message" && i.status === "completed")
		.slice(0, 2)
		.reverse();
	for (const i of last) console.log("ASSISTANT:", String(i.text).slice(-1800), "\n---");
	for (const r of waitingRequests(p))
		for (const q of r.questions ?? [])
			console.log(
				`Q[${r.requestId.slice(-12)}] ${q.header}: ${q.question}\n` +
					(q.options ?? []).map((o) => `  - ${o.label}: ${o.description}`).join("\n"),
			);
	return rpc.ws.close();
}

/** The answers to a waiting request from `<header>=<label>` specs; every question must be answered with one of its options. */
function answersFor(r: TurnItem, specs: string[]): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const spec of specs) {
		const [header, ...lab] = spec.split("=");
		const label = lab.join("=");
		const q = (r.questions ?? []).find((x) => x.header === header);
		if (!q) throw Error(`no question with header "${header}"`);
		if (!(q.options ?? []).some((o) => o.label === label)) throw Error(`"${label}" is not an option of "${header}"`);
		answers[q.id] = label;
	}
	const missing = (r.questions ?? []).filter((q) => !(q.id in answers)).map((q) => q.header);
	if (missing.length) throw Error(`unanswered: ${missing.join(", ")}`);
	return answers;
}

async function respond(rpc: Rpc, srv: Server, threadId: string, specs: string[]) {
	const p = await projection(rpc, threadId);
	const reqs = waitingRequests(p);
	if (reqs.length !== 1) throw Error(`expected exactly one waiting request, found ${reqs.length}`);
	const r = reqs[0] as TurnItem;
	const answers = answersFor(r, specs);
	await rpc.request("orchestration.dispatchCommand", {
		type: "runtime-request.respond",
		commandId: crypto.randomUUID(),
		threadId,
		requestId: r.requestId,
		answers,
	});
	console.log(`responded to ${Object.keys(answers).length} question(s) on ${srv.name}:${threadId}`);
}

async function send(rpc: Rpc, srv: Server, threadId: string, words: string[]) {
	const text = words.join(" ");
	if (!text) throw Error("text required");
	const p = await projection(rpc, threadId);
	await rpc.request(
		"orchestration.dispatchCommand",
		messageCommand({ threadId, text, identity: "steward", activeRunId: activeRunOf(p.runs) }),
	);
	console.log(`sent to ${srv.name}:${threadId}`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const servers: Server[] = (readServers(CONF) ?? []).map(t3Server);

	const [cmd, serverName, threadId, ...rest] = argv;
	const srv = servers.find((s) => s.name === serverName);
	if (!cmd || !srv) {
		console.error(`usage: t3x <threads|read|respond|send> <${servers.map((s) => s.name).join("|")}> ...`);
		process.exit(2);
	}

	if (cmd === "threads") return listThreads(srv);
	if (!threadId) throw Error("threadId required");
	if (cmd === "read") return readThread(srv, threadId);

	if (!srv.operateTokenFile) throw Error(`${srv.name} has no operateTokenFile; it is read-only`);
	const rpc = await connect(srv.origin, priv(srv.operateTokenFile));

	if (cmd === "respond") await respond(rpc, srv, threadId, rest);
	else if (cmd === "send") await send(rpc, srv, threadId, rest);
	else throw Error(`unknown command ${cmd}`);
	rpc.ws.close();
}

if (import.meta.main)
	main().then(
		() => process.exit(0),
		(e) => {
			console.error(String(e instanceof Error ? e.message : e));
			process.exit(1);
		},
	);
