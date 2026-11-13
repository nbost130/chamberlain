/** Minimal Effect-RPC client over T3 /ws. */
// ---- minimal Effect-RPC client over /ws -------------------------------------------------------
export class Rpc {
	next = 100;
	pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; onChunk?: (v: any) => void }>();
	last = Date.now();
	pinger: ReturnType<typeof setInterval>;
	constructor(public ws: WebSocket, public closed: Promise<void>) {
		ws.addEventListener("message", (ev) => this.receive(String(ev.data)));
		// A closed socket ends its client: the pinger stops and waiting calls fail, so nothing outlives the socket.
		ws.addEventListener("close", () => this.fail());
		this.pinger = setInterval(() => {
			try {
				if (Date.now() - this.last > 20000) ws.close();
				else ws.send(JSON.stringify({ _tag: "Ping" }));
			} catch { this.fail(); }
		}, 5000);
	}
	receive(data: string) {
		this.last = Date.now();
		for (const m of ([] as any[]).concat(JSON.parse(data))) {
			const p = this.pending.get(String(m.requestId));
			if (m._tag === "Chunk" && p) {
				for (const v of m.values ?? []) p.onChunk?.(v);
				this.ws.send(JSON.stringify({ _tag: "Ack", requestId: m.requestId }));
			} else if (m._tag === "Exit" && p) {
				this.pending.delete(String(m.requestId));
				m.exit?._tag === "Success" ? p.resolve(m.exit.value) : p.reject(Error("rpc failure: " + JSON.stringify(m.exit).slice(0, 20000)));
			} else if (m._tag === "Defect" || m._tag === "ClientProtocolError") this.ws.close();
		}
	}
	call(tag: string, payload: unknown, onChunk?: (v: any) => void) {
		const id = String(this.next++);
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onChunk });
			this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
		});
	}
	request(tag: string, payload: unknown) { return this.call(tag, payload); }
	fail() { for (const p of this.pending.values()) p.reject(Error("socket closed")); this.pending.clear(); clearInterval(this.pinger); }
}


/** Open an authenticated socket (ticket from a bearer token) and return the client. */
export async function connect(origin: string, token: string): Promise<Rpc> {
	const t = await fetch(new URL("/api/auth/websocket-ticket", origin), { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
	if (!t.ok) throw Error(`ticket refused (HTTP ${t.status})`);
	const { ticket } = (await t.json()) as { ticket: string };
	const url = new URL("/ws", origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("orchestrationProtocol", "2");
	url.searchParams.set("wsTicket", ticket);
	const ws = new WebSocket(url.href);
	let done!: () => void;
	const closed = new Promise<void>((r) => (done = r));
	await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(Error("ws error"))); });
	ws.addEventListener("close", done);
	return new Rpc(ws, closed);
}
