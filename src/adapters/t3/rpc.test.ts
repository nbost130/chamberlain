import { describe, expect, test } from "bun:test";
import { Rpc } from "./rpc";

/** A socket stand-in: records sends, and close() fires the close event like a real WebSocket. */
class FakeSocket extends EventTarget {
	sent: string[] = [];
	send(s: string) { this.sent.push(s); }
	close() { this.dispatchEvent(new Event("close")); }
}

describe("Rpc lifetime", () => {
	// Must catch: the queue page leak (2026-11-11), where every closed connection kept a 5 s pinger alive forever.
	test("a closed socket stops the pinger and fails every waiting call", async () => {
		const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
		const live = new Set<unknown>();
		globalThis.setInterval = ((fn: () => void, ms: number) => { const h = realSet(fn, ms); live.add(h); return h; }) as typeof setInterval;
		globalThis.clearInterval = ((h: ReturnType<typeof setInterval>) => { live.delete(h); realClear(h); }) as typeof clearInterval;
		try {
			const waits: Promise<unknown>[] = [];
			for (let i = 0; i < 50; i++) {
				const ws = new FakeSocket();
				const rpc = new Rpc(ws as unknown as WebSocket, Promise.resolve());
				waits.push(rpc.call("orchestration.subscribeShell", {}).then(() => "resolved", (e) => String(e)));
				ws.close();
				expect(rpc.pending.size).toBe(0);
			}
			expect(live.size).toBe(0);
			expect(new Set(await Promise.all(waits))).toEqual(new Set(["Error: socket closed"]));
		} finally {
			globalThis.setInterval = realSet;
			globalThis.clearInterval = realClear;
		}
	});

	// Must catch: an explicit fail() after the close (daemon.ts does both) throwing or double-rejecting.
	test("fail() after a close is harmless", () => {
		const ws = new FakeSocket();
		const rpc = new Rpc(ws as unknown as WebSocket, Promise.resolve());
		ws.close();
		expect(() => rpc.fail()).not.toThrow();
	});
});
