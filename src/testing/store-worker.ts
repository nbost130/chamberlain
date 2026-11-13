/**
 * A process that hammers the database, for the concurrency tests (src/core/concurrency.test.ts). It waits for a shared
 * start time so several workers write at the same instant, does its work through the Store, and prints a JSON result.
 *
 *   bun src/testing/store-worker.ts <db> <worker id> <startAt ms> <mode> <n>
 *
 * Modes: "writes" does n read-modify-write counter updates, n event appends, n held-wake additions and n answered-item
 * claims of its own; "claims" races every worker for the same n items and prints the ones it won.
 */
import { openStore } from "../core/sqlite-store.ts";

const [path, id, startAt, mode, count] = process.argv.slice(2);
const n = Number(count);
const store = openStore(path!);
while (Date.now() < Number(startAt)) { /* spin until the shared start */ }

if (mode === "writes") {
	for (let i = 0; i < n; i++) {
		store.state.update<number>("counter", (c) => (c ?? 0) + 1);
		store.events.append({ t: new Date().toISOString(), event: "tick", worker: id, i });
		store.wakes.hold({ deliveryId: `w${id}-${i}`, message: "m", queuedAt: i });
		store.tx(() => {
			const key = `Q-${id}x${i}`;
			store.items.observe({ source: "queue", kind: "question", dedupKey: key, mode: "silenced" });
			store.claims.claim("queue", { owner: `w${id}`, item: key, deliveryId: `answer:item:${key}`, message: "m", t: "t" });
		});
	}
	console.log(JSON.stringify({ id }));
} else {
	const won: string[] = [];
	for (let i = 0; i < n; i++) {
		const key = `Q-shared${i}`;
		store.items.observe({ source: "queue", kind: "question", dedupKey: key, mode: "silenced" });
		const r = store.claims.claim("queue", { owner: `w${id}`, item: key, deliveryId: `answer:item:${key}`, message: `wake from ${id}`, t: "t" });
		if (r.won) won.push(key);
	}
	console.log(JSON.stringify({ id, won }));
}
store.close();
