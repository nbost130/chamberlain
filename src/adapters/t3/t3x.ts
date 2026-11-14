/**
 * t3x: act on a thread on any configured T3 server, for the case the t3_* MCP tools can't reach one. Servers come from
 * ~/.config/chamberlain/servers.json; an optional `operateTokenFile` (orchestration:operate) enables respond/send.
 * Tokens are never printed.
 *
 *   bun src/adapters/t3/t3x.ts threads <server>
 *   bun src/adapters/t3/t3x.ts read    <server> <threadId>
 *   bun src/adapters/t3/t3x.ts respond <server> <threadId> "<question header>=<option label>" ...
 *   bun src/adapters/t3/t3x.ts send    <server> <threadId> <text>
 */
import { readFileSync, statSync } from "node:fs";
import { isPrivateFile } from "../../core/private.ts";
import { CONF } from "../../core/config.ts";
import { startup } from "../../core/migrate.ts";
import { connect, type Rpc } from "./rpc.ts";
import { messageCommand } from "./ping.ts";
import { readServers } from "../../core/servers.ts";
import { t3Server, type T3Server } from "./server.ts";

type Server = T3Server;

function priv(name: string): string {
	const p = `${CONF}/${name}`;
	if (!isPrivateFile(statSync(p))) throw Error(`${name} must be a regular file with mode exactly 0600`);
	return readFileSync(p, "utf8").trim();
}
export async function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const servers: Server[] = (readServers(CONF) ?? []).map(t3Server);

	const [cmd, serverName, threadId, ...rest] = argv;
	const srv = servers.find((s) => s.name === serverName);
	if (!cmd || !srv) { console.error(`usage: t3x <threads|read|respond|send> <${servers.map((s) => s.name).join("|")}> ...`); process.exit(2); }

	const projection = async (rpc: Rpc) => (await rpc.request("orchestration.getThreadProjection", { threadId })) as any;
	const waitingRequests = (p: any): any[] => (p.turnItems ?? []).filter((i: any) => i.type === "user_input_request" && i.status === "waiting");
	if (cmd === "threads") {
		const rpc = await connect(srv!.origin, priv(srv!.tokenFile));
		await new Promise<void>((resolve) => {
			rpc.call("orchestration.subscribeShell", {}, (v) => {
				if (v.kind !== "snapshot") return;
				for (const x of v.snapshot.threads ?? []) {
					if (x.settledAt || x.archivedAt || x.lineage?.parentThreadId) continue;
					console.log([x.status, x.id, JSON.stringify(x.title), x.pendingRuntimeRequest ? "PENDING" : "", x.snoozedUntil ? "snoozed" : ""].filter(Boolean).join(" | "));
				}
				resolve();
			}).catch(() => resolve());
		});
		return rpc.ws.close();
	}
	if (!threadId) throw Error("threadId required");

	if (cmd === "read") {
		const rpc = await connect(srv!.origin, priv(srv!.tokenFile));
		const p = await projection(rpc);
		const last = [...(p.turnItems ?? [])].reverse().filter((i: any) => i.type === "assistant_message" && i.status === "completed").slice(0, 2).reverse();
		for (const i of last) console.log("ASSISTANT:", String(i.text).slice(-1800), "\n---");
		for (const r of waitingRequests(p))
			for (const q of r.questions ?? []) console.log(`Q[${r.requestId.slice(-12)}] ${q.header}: ${q.question}\n` + (q.options ?? []).map((o: any) => `  - ${o.label}: ${o.description}`).join("\n"));
		return rpc.ws.close();
	}

	if (!srv!.operateTokenFile) throw Error(`${srv!.name} has no operateTokenFile; it is read-only`);
	const rpc = await connect(srv!.origin, priv(srv!.operateTokenFile));
	const now = new Date().toISOString();

	if (cmd === "respond") {
		const p = await projection(rpc);
		const reqs = waitingRequests(p);
		if (reqs.length !== 1) throw Error(`expected exactly one waiting request, found ${reqs.length}`);
		const r = reqs[0];
		const answers: Record<string, unknown> = {};
		for (const spec of rest) {
			const [header, ...lab] = spec.split("=");
			const label = lab.join("=");
			const q = (r.questions ?? []).find((x: any) => x.header === header);
			if (!q) throw Error(`no question with header "${header}"`);
			if (!(q.options ?? []).some((o: any) => o.label === label)) throw Error(`"${label}" is not an option of "${header}"`);
			answers[q.id] = label;
		}
		const missing = (r.questions ?? []).filter((q: any) => !(q.id in answers)).map((q: any) => q.header);
		if (missing.length) throw Error(`unanswered: ${missing.join(", ")}`);
		await rpc.request("orchestration.dispatchCommand", {
			type: "runtime-request.respond",
			commandId: crypto.randomUUID(),
			threadId,
			requestId: r.requestId,
			answers,
		});
		console.log(`responded to ${Object.keys(answers).length} question(s) on ${srv!.name}:${threadId}`);
	} else if (cmd === "send") {
		const text = rest.join(" ");
		if (!text) throw Error("text required");
		const p = await projection(rpc);
		const active = ([...(p.runs ?? [])].reverse().find((r: any) => ["running", "waiting", "starting"].includes(String(r.status))) as any)?.id as string | undefined;
		await rpc.request("orchestration.dispatchCommand", messageCommand({ threadId: threadId!, text, identity: "steward", activeRunId: active }));
		console.log(`sent to ${srv!.name}:${threadId}`);
	} else throw Error(`unknown command ${cmd}`);
	rpc.ws.close();
}

if (import.meta.main) main().then(() => process.exit(0), (e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
