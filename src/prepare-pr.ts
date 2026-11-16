/**
 * `chamberlain prepare-pr …` — poll no-mistakes prepare-pr runs and emit sweep findings JSON.
 *
 *   prepare-pr status [--repo Name=/path]… [--state-db path] [--settled threadId]…
 *   prepare-pr link <threadId> <runId> [--repo Name]
 *   prepare-pr clear <threadId> <runId>
 *   prepare-pr links [--repo Name] [--all]
 *
 * `status` prints a JSON array of findings on stdout (sweep check contract) and exits 0.
 * Malformed axi output exits non-zero so the check is evaluation_error (fail closed).
 */
import { homedir } from "node:os";
import { connect } from "./adapters/t3/rpc.ts";
import { t3Server } from "./adapters/t3/server.ts";
import { CONF, selfCommand } from "./core/config/config.ts";
import { readSecret } from "./core/config/layout.ts";
import { startup } from "./core/config/migrate.ts";
import { readServers } from "./core/config/servers.ts";
import { DEFAULT_NO_MISTAKES_STATE, DEFAULT_REPOS, type RepoTarget } from "./core/prepare-pr/discover.ts";
import type { PreparePrLink } from "./core/prepare-pr/findings.ts";
import { pollPreparePr } from "./core/prepare-pr/poll.ts";
import { defaultStore } from "./core/store/default-store.ts";
import { listRunningRunIdsFromStateDb, parkedSinceFromStateDb } from "./prepare-pr-nm-state.ts";

const usage = () =>
	[
		`usage: ${selfCommand("prepare-pr")} status [--repo Name=/path]… [--state-db path] [--settled threadId]…`,
		`       ${selfCommand("prepare-pr")} link <threadId> <runId> [--repo Name]`,
		`       ${selfCommand("prepare-pr")} clear <threadId> <runId>`,
		`       ${selfCommand("prepare-pr")} links [--repo Name] [--all]`,
	].join("\n");

const arg = (argv: string[], name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const allArgs = (argv: string[], name: string): string[] => {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== name) continue;
		const v = argv[i + 1];
		if (v) {
			out.push(v);
			i++;
		}
	}
	return out;
};

function parseRepos(argv: string[]): RepoTarget[] {
	const specs = allArgs(argv, "--repo").filter((s) => s.includes("="));
	if (!specs.length) return [...DEFAULT_REPOS];
	return specs.map((s) => {
		const eq = s.indexOf("=");
		const name = s.slice(0, eq).trim();
		const path = s
			.slice(eq + 1)
			.trim()
			.replace(/^~(?=\/)/, homedir());
		if (!name || !path) throw Error(`prepare-pr: bad --repo ${s} (want Name=/path)`);
		return { name, path };
	});
}

function collectSettledFromSnapshot(
	threads: readonly { id?: unknown; settledAt?: unknown; unsettledAt?: unknown }[],
	want: ReadonlySet<string>,
	into: Set<string>,
): void {
	for (const x of threads) {
		const id = typeof x.id === "string" ? x.id : "";
		if (!want.has(id)) continue;
		if (x.settledAt && !x.unsettledAt) into.add(id);
	}
}

/** One server's shell snapshot → settled ids among `want` (best-effort). */
async function probeServerSettled(
	origin: string,
	token: string,
	want: ReadonlySet<string>,
	into: Set<string>,
): Promise<void> {
	const rpc = await connect(origin, token);
	try {
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => resolve(), 8_000);
			const done = () => {
				clearTimeout(t);
				resolve();
			};
			rpc
				.call("orchestration.subscribeShell", {}, (v) => {
					if (v.kind !== "snapshot") return;
					collectSettledFromSnapshot(v.snapshot.threads ?? [], want, into);
					done();
				})
				.catch(done);
		});
	} finally {
		rpc.ws.close();
	}
}

/** Optional: which linked threads are settled on any configured T3 server (best-effort; skips on failure). */
async function probeSettled(threadIds: readonly string[]): Promise<Set<string>> {
	const settled = new Set<string>();
	if (!threadIds.length) return settled;
	const want = new Set(threadIds);
	for (const entry of readServers(CONF) ?? []) {
		const srv = t3Server(entry);
		const token = srv ? readSecret(CONF, srv.tokenFile) : undefined;
		if (!srv || !token) continue;
		try {
			await probeServerSettled(srv.origin, token, want, settled);
		} catch {
			/* offline: skip */
		}
	}
	return settled;
}

async function cmdStatus(argv: string[]): Promise<void> {
	const repos = parseRepos(argv);
	const stateDb = (arg(argv, "--state-db") ?? DEFAULT_NO_MISTAKES_STATE).replace(/^~(?=\/)/, homedir());
	const store = defaultStore();
	try {
		const open = store.preparePrLinks.listOpen();
		const links: PreparePrLink[] = open.map((l) => ({
			threadId: l.threadId,
			runId: l.runId,
			repo: l.repo,
			startedAt: l.startedAt,
			clearedAt: l.clearedAt,
		}));
		const injected = allArgs(argv, "--settled");
		const linkedIds = [...new Set(links.map((l) => l.threadId))];
		// `--settled` is hermetic / operator override; otherwise best-effort T3 probe (skips if offline).
		const settled = injected.length ? new Set(injected) : await probeSettled(linkedIds);

		const findings = await pollPreparePr({
			repos,
			links,
			settledThreadIds: settled,
			listRunning: (workingPath) => listRunningRunIdsFromStateDb(stateDb, workingPath),
			parkedSinceOf: (runIds) => parkedSinceFromStateDb(stateDb, runIds),
		});
		console.log(JSON.stringify(findings));
	} finally {
		store.close();
	}
}

function cmdLink(argv: string[]): void {
	const [threadId, runId] = argv;
	if (!threadId || !runId || threadId.startsWith("-") || runId.startsWith("-"))
		throw Error(`usage: ${selfCommand("prepare-pr")} link <threadId> <runId> [--repo Name]`);
	const repo = arg(argv, "--repo") ?? DEFAULT_REPOS[0]?.name ?? "MemberHero";
	const store = defaultStore();
	try {
		const wrote = store.preparePrLinks.link(threadId, runId, repo);
		console.log(wrote ? `linked ${threadId} ↔ ${runId} (${repo})` : `already linked ${threadId} ↔ ${runId} (${repo})`);
	} finally {
		store.close();
	}
}

function cmdClear(argv: string[]): void {
	const [threadId, runId] = argv;
	if (!threadId || !runId) throw Error(`usage: ${selfCommand("prepare-pr")} clear <threadId> <runId>`);
	const store = defaultStore();
	try {
		const ok = store.preparePrLinks.clear(threadId, runId);
		console.log(ok ? `cleared ${threadId} ↔ ${runId}` : `no open link ${threadId} ↔ ${runId}`);
	} finally {
		store.close();
	}
}

function cmdLinks(argv: string[]): void {
	const repo = arg(argv, "--repo");
	const all = argv.includes("--all");
	const store = defaultStore();
	try {
		const rows = all
			? store.tx(() => {
					// listOpen only; --all still means open for v1 (cleared history not listed)
					return store.preparePrLinks.listOpen(repo);
				})
			: store.preparePrLinks.listOpen(repo);
		if (!rows.length) {
			console.log("no open prepare-pr links");
			return;
		}
		for (const r of rows) console.log(`${r.threadId}\t${r.runId}\t${r.repo}\t${new Date(r.startedAt).toISOString()}`);
	} finally {
		store.close();
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	startup();
	const [cmd, ...rest] = argv;
	if (cmd === undefined || cmd === "status" || cmd.startsWith("-")) {
		await cmdStatus(cmd === "status" ? rest : argv);
		return;
	}
	if (cmd === "link") {
		cmdLink(rest);
		return;
	}
	if (cmd === "clear") {
		cmdClear(rest);
		return;
	}
	if (cmd === "links") {
		cmdLinks(rest);
		return;
	}
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(usage());
		return;
	}
	throw Error(`${usage()}`);
}

if (import.meta.main) {
	try {
		await main();
	} catch (e) {
		console.error(String(e instanceof Error ? e.message : e));
		process.exit(1);
	}
}
