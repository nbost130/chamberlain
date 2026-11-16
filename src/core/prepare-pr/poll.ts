/**
 * Poll configured repos for parked prepare-pr runs and emit sweep findings.
 * Local exec only (same host as the daemon). Fail closed on discovery/status errors.
 */
import { spawn } from "node:child_process";
import type { Finding } from "../items/source.ts";
import { type AxiParkedRun, isValidAxiOverview, parseAxiStatus } from "./axi-parse.ts";
import { activeRunIdsFromAxiOverview, DEFAULT_REPOS, mergeActiveRunIds, type RepoTarget } from "./discover.ts";
import { type PreparePrKindFilter, type PreparePrLink, preparePrFindings } from "./findings.ts";

type ExecFn = (cmd: string[], cwd: string, timeoutMs: number) => Promise<{ stdout: string; code: number }>;

async function defaultExec(cmd: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
	const [bin, ...args] = cmd;
	if (!bin) throw Error("exec: empty command");
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let _stderr = "";
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			reject(Error(`timed out after ${timeoutMs}ms: ${cmd.join(" ")}`));
		}, timeoutMs);
		child.stdout.on("data", (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr.on("data", (b: Buffer) => {
			_stderr += b.toString();
		});
		child.on("error", (e) => {
			clearTimeout(t);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(t);
			resolve({ stdout, code: code ?? 1 });
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
	kinds?: PreparePrKindFilter;
	/** Running run ids for a repo working_path (from state.sqlite). Must throw when coverage cannot be established. */
	listRunning?: (workingPath: string) => string[];
	parkedSinceOf?: (runIds: readonly string[]) => Map<string, number>;
	fixtures?: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

const AXI = ["bun", "run", "no-mistakes", "axi"];

function requireExit0(label: string, r: { stdout: string; code: number }): string {
	if (r.code !== 0) throw Error(`${label} exited ${r.code}${r.stdout.trim() ? "" : " with empty stdout"}`);
	return r.stdout;
}

async function axiOverview(o: {
	exec: ExecFn;
	repoPath: string;
	prefix: string[];
	timeoutMs: number;
}): Promise<string> {
	const out = requireExit0("axi overview", await o.exec([...o.prefix], o.repoPath, o.timeoutMs));
	if (!isValidAxiOverview(out)) throw Error("axi overview: unrecognized output");
	return out;
}

async function axiStatus(o: {
	exec: ExecFn;
	repoPath: string;
	prefix: string[];
	runId: string;
	timeoutMs: number;
}): Promise<string> {
	return requireExit0(
		`axi status --run ${o.runId}`,
		await o.exec([...o.prefix, "status", "--run", o.runId], o.repoPath, o.timeoutMs),
	);
}

async function statusRun(
	repo: RepoTarget,
	runId: string,
	o: { exec: ExecFn; axiPrefix: string[]; timeoutMs: number; fixture?: string },
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
		/** Open prepare-pr link run ids for this repo (always statused, even if discovery missed them). */
		linkRunIds?: readonly string[];
		fixtures?: ReadonlyMap<string, string>;
	},
): Promise<{ runs: AxiParkedRun[]; parkedSince: Map<string, number> }> {
	const fx = o.fixtures;
	let overview: string;
	if (fx?.has("__overview__")) {
		overview = fx.get("__overview__") ?? "";
		if (!isValidAxiOverview(overview) && overview.trim() !== "")
			throw Error("axi overview fixture: unrecognized output");
	} else {
		overview = await axiOverview({
			exec: o.exec,
			repoPath: repo.path,
			prefix: o.axiPrefix,
			timeoutMs: o.timeoutMs,
		});
	}
	const fromAxi = overview.trim() ? activeRunIdsFromAxiOverview(overview) : [];
	const fromDb = o.listRunning(repo.path);
	const fromLinks = o.linkRunIds ?? [];
	const ids = mergeActiveRunIds(fromDb, fromAxi, fromLinks);
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

/** Poll every configured repo and return sweep findings. Throws → evaluation_error (fail closed). */
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
		const links = (opts.links ?? []).filter((l) => l.repo === repo.name && l.clearedAt == null);
		const { runs, parkedSince } = await pollRepo(repo, {
			exec,
			axiPrefix,
			timeoutMs,
			listRunning,
			parkedSinceOf,
			linkRunIds: links.map((l) => l.runId),
			...(repoFx ? { fixtures: repoFx } : {}),
		});
		findings.push(
			...preparePrFindings({
				repo: repo.name,
				runs,
				nowMs,
				parkedSinceByRun: parkedSince,
				links,
				kinds: opts.kinds ?? "all",
				...(opts.settledThreadIds ? { settledThreadIds: opts.settledThreadIds } : {}),
			}),
		);
	}
	return findings;
}
