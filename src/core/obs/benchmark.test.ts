/** The append budget (docs/OBSERVABILITY.md section 8): p99 under 1 ms, on a real file in WAL mode, the way every module calls it. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memObs, THREAD } from "../../testing/obs.ts";
import { makeLogger } from "./logger.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Calls per round and warm-up calls. CI's run of the first version (3 rounds of 7,000 calls and 1,000 warm-up, 24,000 calls) was killed by the 5 s default
 * timeout, so a call costs at least 210 us there against about 130 us on a loaded dev box. 3,000 samples still put the p99 at the 30th slowest call;
 * the call count is now 10,500 (about 2.2 s on CI) and the test is given 15 s, more than six times that.
 */
const SAMPLES = 3000;
const WARMUP = 500;
const TIMEOUT_MS = 15_000;

function p99(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length * 0.99)] ?? 0;
}

/**
 * The p99 of three independent rounds, middle one: a neighbour that stalls this process for a moment spoils one round and not the median,
 * while a call that is really slow is slow in all three.
 */
function steadyP99(call: (i: number) => void): number {
	const rounds = [0, 1, 2].map(() => p99(measure(call, SAMPLES)));
	return rounds.sort((a, b) => a - b)[1] ?? 0;
}

function measure(call: (i: number) => void, n: number): number[] {
	for (let i = 0; i < WARMUP; i++) call(i);
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = performance.now();
		call(i);
		out.push(performance.now() - t);
	}
	return out;
}

test(
	"a typed call's append is under 1 ms at p99, with a bound thread and correlation id",
	() => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-bench-`);
		dirs.push(dir);
		const obs = memObs({ path: `${dir}/obs.db` });
		const log = makeLogger(obs, { mod: "relay", thread: THREAD, corr: "0123456789ab" });
		const budget = steadyP99((i) => log.info("wake.delivered", { http: 202, attempt: i % 3 }));
		obs.close();
		expect(budget).toBeLessThan(1);
		expect(obs.counters).toEqual({ rejected: 0, redacted: 0, failed: 0, dropped: 0 });
	},
	TIMEOUT_MS,
);

test(
	"so is a call through the old shape, which the registry reads",
	() => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-bench-`);
		dirs.push(dir);
		const obs = memObs({ path: `${dir}/obs.db` });
		obs.allow("server", ["mac"]);
		const log = makeLogger(obs, {});
		const budget = steadyP99((i) =>
			log("fire", { server: "mac", kind: "needs_input", threadId: THREAD, title: "Fix the login bug", n: i }),
		);
		obs.close();
		expect(budget).toBeLessThan(1);
	},
	TIMEOUT_MS,
);

test(
	"and a rejected call, the cheapest path, never costs more",
	() => {
		const obs = memObs();
		const log = makeLogger(obs, {});
		expect(steadyP99(() => log.info("not.registered" as never, { a: 1 }))).toBeLessThan(1);
	},
	TIMEOUT_MS,
);
