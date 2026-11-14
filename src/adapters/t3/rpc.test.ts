import { describe, expect, test } from "bun:test";
import { Rpc, shellSnapshot } from "./rpc";

/** A socket stand-in: records sends, and close() fires the close event like a real WebSocket. */
class FakeSocket extends EventTarget {
	sent: string[] = [];
	send(s: string) {
		this.sent.push(s);
	}
	close() {
		this.dispatchEvent(new Event("close"));
	}
}

describe("Rpc lifetime", () => {
	// Must catch: the queue page leak (2026-11-11), where every closed connection kept a 5 s pinger alive forever.
	test("a closed socket stops the pinger and fails every waiting call", async () => {
		const realSet = globalThis.setInterval,
			realClear = globalThis.clearInterval;
		const live = new Set<unknown>();
		globalThis.setInterval = ((fn: () => void, ms: number) => {
			const h = realSet(fn, ms);
			live.add(h);
			return h;
		}) as typeof setInterval;
		globalThis.clearInterval = ((h: ReturnType<typeof setInterval>) => {
			live.delete(h);
			realClear(h);
		}) as typeof clearInterval;
		try {
			const waits: Promise<unknown>[] = [];
			for (let i = 0; i < 50; i++) {
				const ws = new FakeSocket();
				const rpc = new Rpc(ws as unknown as WebSocket, Promise.resolve());
				waits.push(
					rpc.call("orchestration.subscribeShell", {}).then(
						() => "resolved",
						(e) => String(e),
					),
				);
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

describe("Rpc.receive: what each server message does", () => {
	const open = () => {
		const ws = new FakeSocket();
		return { ws, rpc: new Rpc(ws as unknown as WebSocket, Promise.resolve()) };
	};
	test("an Exit with a Success resolves the call with its value and forgets it", async () => {
		const { rpc } = open();
		const p = rpc.call("x", {});
		rpc.receive(JSON.stringify({ _tag: "Exit", requestId: "100", exit: { _tag: "Success", value: { ok: 1 } } }));
		expect(await p).toEqual({ ok: 1 });
		expect(rpc.pending.size).toBe(0);
		rpc.fail();
	});
	test("an Exit that is not a Success rejects the call with the failure text", async () => {
		const { rpc } = open();
		const p = rpc.call("x", {});
		rpc.receive(JSON.stringify({ _tag: "Exit", requestId: "100", exit: { _tag: "Failure", cause: "boom" } }));
		await expect(p).rejects.toThrow('rpc failure: {"_tag":"Failure","cause":"boom"}');
		expect(rpc.pending.size).toBe(0);
		rpc.fail();
	});
	test("a Chunk is acknowledged, and a batch of messages is read in order", () => {
		const { ws, rpc } = open();
		const seen: unknown[] = [];
		void rpc.call("x", {}, (v) => seen.push(v)).catch(() => {});
		rpc.receive(JSON.stringify([{ _tag: "Chunk", requestId: "100", values: [{ kind: "a" }, { kind: "b" }] }]));
		expect(seen).toEqual([{ kind: "a" }, { kind: "b" }]);
		expect(ws.sent.at(-1)).toBe(JSON.stringify({ _tag: "Ack", requestId: "100" }));
		rpc.fail();
	});
	test("a Defect or a protocol error closes the socket; a message for no known call changes nothing", () => {
		for (const _tag of ["Defect", "ClientProtocolError"]) {
			const { ws, rpc } = open();
			let closed = false;
			ws.addEventListener("close", () => {
				closed = true;
			});
			rpc.receive(JSON.stringify({ _tag }));
			expect(closed).toBe(true);
		}
		const { ws, rpc } = open();
		const before = ws.sent.length;
		rpc.receive(JSON.stringify({ _tag: "Chunk", requestId: "999", values: [{}] }));
		rpc.receive(JSON.stringify({ _tag: "Exit", requestId: "999", exit: { _tag: "Success" } }));
		expect(ws.sent.length).toBe(before);
		rpc.fail();
	});
});

describe("shellSnapshot: one fresh read of a server's threads", () => {
	const chunk = (rpc: Rpc, value: unknown) =>
		rpc.receive(JSON.stringify({ _tag: "Chunk", requestId: "100", values: [value] }));
	test("resolves with the first snapshot's thread list", async () => {
		const rpc = new Rpc(new FakeSocket() as unknown as WebSocket, Promise.resolve());
		const p = shellSnapshot(rpc, 1000);
		chunk(rpc, { kind: "snapshot", snapshot: { snapshotSequence: 5, threads: [{ id: "t1" }, { id: "t2" }] } });
		expect((await p).threads.map((t) => t.id)).toEqual(["t1", "t2"]);
		expect(rpc.pending.size).toBe(0);
	});
	test("a snapshot with no thread list is not a snapshot: it times out rather than reading as 'no threads'", async () => {
		const rpc = new Rpc(new FakeSocket() as unknown as WebSocket, Promise.resolve());
		const p = shellSnapshot(rpc, 30);
		chunk(rpc, { kind: "snapshot", snapshot: {} });
		await expect(p).rejects.toThrow("snapshot timed out");
	});
	test("a snapshot that marks itself partial is refused, never read as every thread", async () => {
		for (const mark of [
			{ partial: true },
			{ complete: false },
			{ truncated: true },
			{ hasMore: true },
			{ nextCursor: "c2" },
		]) {
			const rpc = new Rpc(new FakeSocket() as unknown as WebSocket, Promise.resolve());
			const p = shellSnapshot(rpc, 1000);
			chunk(rpc, { kind: "snapshot", snapshot: { threads: [{ id: "t1" }], ...mark } });
			await expect(p).rejects.toThrow("partial snapshot");
		}
	});
	test("a stream that ends first, or a socket that closes, is a failure", async () => {
		const rpc = new Rpc(new FakeSocket() as unknown as WebSocket, Promise.resolve());
		const p = shellSnapshot(rpc, 1000);
		rpc.receive(JSON.stringify({ _tag: "Exit", requestId: "100", exit: { _tag: "Success", value: null } }));
		await expect(p).rejects.toThrow("stream ended before a snapshot");
		const ws2 = new FakeSocket();
		const rpc2 = new Rpc(ws2 as unknown as WebSocket, Promise.resolve());
		const p2 = shellSnapshot(rpc2, 1000);
		ws2.close();
		await expect(p2).rejects.toThrow("socket closed");
	});
});
