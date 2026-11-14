/**
 * peek: the end of a thread in plain lines, with none of the ids and metadata t3_thread_read returns.
 * It costs about a tenth of the tokens, so it is the Steward's first read of any thread.
 *
 *   bun src/adapters/t3/peek.ts <server> <threadId> [messages=3] [chars=400]
 */
import { CONF, principal } from "../../core/config.ts";
import { readSecret } from "../../core/layout.ts";
import { connect } from "./rpc.ts";
import { readServers } from "../../core/servers.ts";
import { t3Server } from "./server.ts";

type Item = {
	type?: string;
	status?: string;
	text?: string;
	createdBy?: string;
	creationSource?: string;
	updatedAt?: string;
	title?: string;
};
const WHO = (): Record<string, string> => ({ user_message: principal(), assistant_message: "thread" });

/** Pure: who said what last, oldest first, plus any card still waiting. */
export function peekLines(items: Item[], n = 3, chars = 400): string[] {
	const who = WHO();
	const said = items.filter((i) => who[i.type ?? ""] && i.text?.trim() && !i.text.startsWith("/compact"));
	const lines = said.slice(-n).map((i) => {
		const name = i.type === "user_message" && i.createdBy !== "user" ? "agent" : who[i.type ?? ""];
		const text = (i.text ?? "").replace(/\s+/g, " ").trim();
		return `${i.updatedAt?.slice(11, 16) ?? "--:--"} ${name}: ${text.length > chars ? `${text.slice(-chars)} [end of ${text.length}]` : text}`;
	});
	const waiting = items.filter((i) => i.status === "waiting" && /request/.test(i.type ?? ""));
	return waiting.length ? [...lines, `WAITING: ${waiting.length} card or approval open`] : lines;
}

export async function main(argv: string[] = process.argv.slice(2)) {
	const [server, threadId, n, chars] = argv;
	const servers = readServers(CONF) ?? [];
	const found = servers.find((s) => s.name === server);
	const srv = found && t3Server(found);
	if (!srv || !threadId) {
		console.error(`usage: peek <${servers.map((s) => s.name).join("|")}> <threadId> [messages] [chars]`);
		process.exit(2);
	}
	const rpc = await connect(srv.origin, readSecret(CONF, srv.tokenFile) ?? "");
	const p = (await rpc.request("orchestration.getThreadProjection", { threadId })) as { turnItems?: Item[] };
	console.log(peekLines(p.turnItems ?? [], Number(n) || 3, Number(chars) || 400).join("\n"));
	process.exit(0);
}

if (import.meta.main) await main();
