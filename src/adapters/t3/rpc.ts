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

/**
 * One fresh, whole read of a T3 server's threads over a socket of its own: subscribe to the shell stream with no resume
 * point, take the first snapshot, and close. Rejects when the stream ends first, errors, or says nothing within `ms`.
 * Resolves only with a snapshot that carries a thread list, so a short or empty answer is a failure, never "no threads"; one that
 * marks itself partial (`partial`, `complete: false`, `truncated`, `hasMore`, a `nextCursor`) rejects.
 */
export function shellSnapshot(rpc: Rpc, ms = 15000): Promise<{ threads: any[] }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { reject(Error("snapshot timed out")); rpc.ws.close(); }, ms);
		rpc.call("orchestration.subscribeShell", {}, (v) => {
			if (v?.kind === "snapshot" && Array.isArray(v.snapshot?.threads)) {
				clearTimeout(timer);
				// A snapshot that says it is not whole is refused, never read as "these are all the threads".
				const s = v.snapshot;
				if (s.partial === true || s.complete === false || s.truncated === true || s.hasMore === true || (s.nextCursor !== undefined && s.nextCursor !== null)) reject(Error("partial snapshot"));
				else resolve({ threads: s.threads });
				rpc.ws.close();
			}
		}).then(() => reject(Error("stream ended before a snapshot")), reject).finally(() => clearTimeout(timer));
	});
}
export async function fetchShellSnapshot(origin: string, token: string, ms = 15000): Promise<{ threads: any[] }> {
	const rpc = await connect(origin, token);
	try { return await shellSnapshot(rpc, ms); } finally { rpc.ws.close(); rpc.fail(); }
}
