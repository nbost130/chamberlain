/**
 * Poll configured repos for parked prepare-pr runs and emit sweep findings.
 * Local exec only (same host as the daemon). No SSH host runner in v1.
 * state.sqlite readers are injected (wired in src/prepare-pr.ts) so core never opens bun:sqlite.
 */
import { spawn } from "node:child_process";
import type { Finding } from "../items/source.ts";
import { type AxiParkedRun, parseAxiStatus } from "./axi-parse.ts";
import { activeRunIdsFromAxiOverview, DEFAULT_REPOS, mergeActiveRunIds, type RepoTarget } from "./discover.ts";
import { type PreparePrLink, preparePrFindings } from "./findings.ts";

type ExecFn = (cmd: string[], cwd: string, timeoutMs: number) => Promise<{ stdout: string; code: number }>;

/** Default: run argv in cwd; non-zero exit still returns stdout (caller decides). */
async function defaultExec(cmd: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
	const [bin, ...args] = cmd;
	if (!bin) throw Error("exec: empty command");
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			reject(Error(`timed out after ${timeoutMs}ms: ${cmd.join(" ")}`));
		}, timeoutMs);
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr.on("data", (b: Buffer) => {
			stderr += b.toString();
		});
		child.on("error", (e) => {
			clearTimeout(t);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0 && !stdout.trim())
				reject(
					Error(`${cmd.join(" ")} exited ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`),
				);
			else resolve({ stdout, code: code ?? 1 });
		});
	});
}

export type PollOptions = {
	repos?: readonly RepoTarget[];
	nowMs?: number;
	exec?: ExecFn;
	axiPrefix?: string[];
	timeoutMs?: number;
	links?: readonly PreparePrLink[];
	settledThreadIds?: ReadonlySet<string>;
	/** Running run ids for a repo working_path (from state.sqlite). */
	listRunning?: (workingPath: string) => string[];
	/** awaiting_agent_since map for run ids. */
	parkedSinceOf?: (runIds: readonly string[]) => Map<string, number>;
	/**
	 * Test inject: map repo name → axi status stdout by run id (skips live exec for those).
	 * Overview inject: `__overview__` key.
	 */
	fixtures?: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

const AXI = ["bun", "run", "no-mistakes", "axi"];

async function axiOverview(o: {
	exec: ExecFn;
	repoPath: string;
	prefix: string[];
	timeoutMs: number;
}): Promise<string> {
	const r = await o.exec([...o.prefix], o.repoPath, o.timeoutMs);
	return r.stdout;
}

async function axiStatus(o: {
	exec: ExecFn;
	repoPath: string;
	prefix: string[];
	runId: string;
	timeoutMs: number;
}): Promise<string> {
	const r = await o.exec([...o.prefix, "status", "--run", o.runId], o.repoPath, o.timeoutMs);
	return r.stdout;
}

async function statusRun(
	repo: RepoTarget,
	runId: string,
	o: {
		exec: ExecFn;
		axiPrefix: string[];
		timeoutMs: number;
		fixture?: string;
	},
): Promise<AxiParkedRun> {
	const out =
		o.fixture ??
		(await axiStatus({
			exec: o.exec,
			repoPath: repo.path,
			prefix: o.axiPrefix,
			runId,
			timeoutMs: o.timeoutMs,
		}));
	return parseAxiStatus(out, runId);
}

async function pollRepo(
	repo: RepoTarget,
	o: {
		exec: ExecFn;
		axiPrefix: string[];
		timeoutMs: number;
		listRunning: (workingPath: string) => string[];
		parkedSinceOf: (runIds: readonly string[]) => Map<string, number>;
		fixtures?: ReadonlyMap<string, string>;
	},
): Promise<{ runs: AxiParkedRun[]; parkedSince: Map<string, number> }> {
	const fx = o.fixtures;
	let overview = fx?.get("__overview__");
	if (overview === undefined) {
		try {
			overview = await axiOverview({
				exec: o.exec,
				repoPath: repo.path,
				prefix: o.axiPrefix,
				timeoutMs: o.timeoutMs,
			});
		} catch {
			overview = "";
		}
	}
	const fromAxi = overview ? activeRunIdsFromAxiOverview(overview) : [];
	const fromDb = o.listRunning(repo.path);
	const ids = mergeActiveRunIds(fromDb, fromAxi);
	const runIds = ids.length > 0 ? ids : fx ? [...fx.keys()].filter((k) => k !== "__overview__") : [];

	const runs: AxiParkedRun[] = [];
	for (const id of runIds) {
		const fixture = fx?.get(id);
		runs.push(
			await statusRun(repo, id, {
				exec: o.exec,
				axiPrefix: o.axiPrefix,
				timeoutMs: o.timeoutMs,
				...(fixture !== undefined ? { fixture } : {}),
			}),
		);
	}
	return { runs, parkedSince: o.parkedSinceOf(runIds) };
}

/** Poll every configured repo and return sweep findings. */
export async function pollPreparePr(opts: PollOptions = {}): Promise<Finding[]> {
	const repos = opts.repos ?? DEFAULT_REPOS;
	const nowMs = opts.nowMs ?? Date.now();
	const exec = opts.exec ?? defaultExec;
	const axiPrefix = opts.axiPrefix ?? AXI;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const listRunning = opts.listRunning ?? (() => []);
	const parkedSinceOf = opts.parkedSinceOf ?? (() => new Map());
	const findings: Finding[] = [];

	for (const repo of repos) {
		const repoFx = opts.fixtures?.get(repo.name);
		const { runs, parkedSince } = await pollRepo(repo, {
			exec,
			axiPrefix,
			timeoutMs,
			listRunning,
			parkedSinceOf,
			...(repoFx ? { fixtures: repoFx } : {}),
		});
		const links = (opts.links ?? []).filter((l) => l.repo === repo.name && l.clearedAt == null);
		findings.push(
			...preparePrFindings({
				repo: repo.name,
				runs,
				nowMs,
				parkedSinceByRun: parkedSince,
				links,
				...(opts.settledThreadIds ? { settledThreadIds: opts.settledThreadIds } : {}),
			}),
		);
	}
	return findings;
}
