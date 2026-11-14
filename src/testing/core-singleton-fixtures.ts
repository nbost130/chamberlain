import { afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export type StartOpts = { env?: Record<string, string>; cwd?: string; startAt?: number; flags?: string };

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreSingletonFixtures() {
	const HOLD = new URL("./hold-relay.ts", import.meta.url).pathname;

	const WORKER = new URL("./store-worker.ts", import.meta.url).pathname;

	const dirs: string[] = [];

	const pids: number[] = [];

	afterEach(() => {
		for (const pid of pids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const scratch = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-singleton-`);
		dirs.push(d);
		return d;
	};

	/** A starter process; `env` replaces the inherited XDG_RUNTIME_DIR and TMPDIR. */
	function starter(db: string, holdMs: number, o: StartOpts = {}) {
		const p = Bun.spawn([process.execPath, HOLD, db, String(holdMs), String(o.startAt ?? 0), o.flags ?? ""], {
			stdout: "pipe",
			stderr: "pipe",
			cwd: o.cwd,
			env: { ...process.env, ...o.env },
		});
		return {
			p,
			out: () => new Response(p.stdout).text().then((t) => t.trim()),
			first: async () => {
				const r = p.stdout.getReader();
				const { value } = await r.read();
				r.releaseLock();
				return new TextDecoder().decode(value).trim();
			},
		};
	}

	/** A holder like the daemon: the Store open on the database, and a second local acquisition refused (flags `store,twice`). Waits for "held". */
	async function holder(db: string, o: StartOpts = {}) {
		const s = starter(db, 30_000, { flags: "store,twice", ...o });
		const line = await s.first();
		expect(line.split(" ")[0]).toBe("held");
		return { ...s, extra: line.split(" ").slice(1) };
	}

	const refusedFor = async (db: string, o: StartOpts = {}) => await starter(db, 10, o).out();

	const kill = async (h: { p: ReturnType<typeof Bun.spawn> }) => {
		h.p.kill("SIGKILL");
		await h.p.exited;
	};

	return { WORKER, pids, scratch, starter, holder, refusedFor, kill };
}
