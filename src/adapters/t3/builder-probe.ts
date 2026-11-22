import type { AdapterEnv, BuilderLaunch, BuilderProbeRequest, BuilderProbeResult } from "../../core/adapter/adapter.ts";
import type { BuilderCandidate, BuilderCandidateStatus } from "../../core/llm/builder-routing.ts";
import { within } from "../../core/within.ts";
import { modelConnection, threadModelIssue } from "./model.ts";
import { type Catalog, readModelCatalog } from "./model-catalog.ts";
import { openWithin } from "./ping.ts";
import { isObject } from "./projection.ts";
import { connect, isPartialShell, type Rpc, type ShellThreadRecord, type StreamValue } from "./rpc.ts";
import { firstValue } from "./rpc-first.ts";
import type { T3Server } from "./server.ts";

const PROBE_TIMEOUT_MS = 15_000;
const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);
const KNOWN = new Set([...ACTIVE, "idle", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

type ProjectWorkspace = { id: string; workspaceRoot: string; repositoryRoot: string };
function projectFor(projects: unknown[], key: string): ProjectWorkspace | undefined {
	const matches = projects.filter(
		(project) =>
			isObject(project) && !project.archivedAt && !project.deletedAt && (project.id === key || project.title === key),
	);
	const project = matches[0];
	if (matches.length !== 1 || !isObject(project) || !text(project.id) || !text(project.workspaceRoot)) return;
	const root = isObject(project.repositoryIdentity) ? project.repositoryIdentity.rootPath : undefined;
	return {
		id: project.id,
		workspaceRoot: project.workspaceRoot,
		repositoryRoot: repositoryRoot(project.workspaceRoot, root),
	};
}

function repositoryRoot(workspace: string, reportedRoot: unknown): string {
	if (!text(reportedRoot)) return workspace;
	const base = reportedRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	const path = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
	return path === base || path.startsWith(`${base}/`) ? reportedRoot : workspace;
}
function liveBackground(thread: ShellThreadRecord): boolean {
	return (
		Array.isArray(thread.pendingBackgroundTasks) &&
		thread.pendingBackgroundTasks.some(
			(task) => text(task?.taskId) && task.kind !== "monitor" && !task.taskId.startsWith("pull-request-watch:"),
		)
	);
}

const foregroundBlocked = (thread: ShellThreadRecord) =>
	thread.blockedOnThreadWait || (thread.pendingRuntimeRequest && thread.pendingRuntimeRequest.blocking !== false);
const activeThread = (thread: ShellThreadRecord, status: string) =>
	liveBackground(thread) || (ACTIVE.has(status) && !foregroundBlocked(thread));

function threadIds(snapshot: StreamValue["snapshot"], residents: readonly string[]) {
	const active = new Set<string>();
	const archived = snapshot.archivedThreads?.map((thread) => thread?.id) ?? [];
	if (!archived.every(text)) return;
	const observed = new Set<string>(archived);
	const residentIds = new Set(residents);
	for (const thread of snapshot.threads ?? []) {
		if (!text(thread?.id)) return;
		observed.add(thread.id);
		if (thread.archivedAt || residentIds.has(thread.id)) continue;
		const status = thread.status;
		if (!text(status) || !KNOWN.has(status)) return;
		if (activeThread(thread, status)) active.add(thread.id);
	}
	return { activeThreadIds: [...active], observedThreadIds: [...observed] };
}

async function workspaceAvailable(
	rpc: Rpc,
	project: ProjectWorkspace,
	strategy: BuilderProbeRequest["workspaceStrategy"],
) {
	const paths = [project.workspaceRoot];
	if (strategy === "worktree") paths.push(`${project.repositoryRoot.replace(/[/\\]+$/, "")}/.git`);
	const metadata = await within(
		rpc.request("filesystem.getMetadata", { paths }),
		PROBE_TIMEOUT_MS,
		"workspace metadata",
	).catch(() => undefined);
	if (!isObject(metadata) || !Array.isArray(metadata.entries) || metadata.entries[0]?.kind !== "directory")
		return false;
	return strategy === "root" || ["directory", "file"].includes(metadata.entries[1]?.kind);
}

function candidateStatus(candidate: BuilderCandidate, catalog: Catalog, projectId: string): BuilderCandidateStatus {
	const enabled =
		catalog.settings?.projectSettingsOverrides?.[projectId]?.providerInstances?.[candidate.instanceId]?.enabled;
	if (enabled === false) return "project-override";
	try {
		return threadModelIssue(candidate, catalog, false, enabled)?.status ?? "eligible";
	} catch {
		return "provider-unavailable";
	}
}

function builderLaunch(candidate: BuilderCandidate, environmentId: string, projectId: string): BuilderLaunch {
	return {
		environmentId,
		projectId,
		modelSelection: {
			instanceId: candidate.instanceId,
			model: candidate.model,
			options: Object.entries(candidate.options).map(([id, value]) => ({ id, value })),
		},
	};
}

function environmentFor(catalog: Catalog, server: T3Server): string | undefined {
	const environmentId = catalog.environment?.environmentId;
	if (text(environmentId) && (server.environmentId === undefined || server.environmentId === environmentId))
		return environmentId;
}

async function builderCatalog(rpc: Rpc, origin: string, readToken: string, operateToken: string): Promise<Catalog> {
	if (readToken === operateToken) return readModelCatalog(rpc);
	const modelRpc = await openWithin(connect, origin, operateToken, PROBE_TIMEOUT_MS);
	try {
		return await readModelCatalog(modelRpc);
	} finally {
		modelRpc.ws.close();
		modelRpc.fail();
	}
}

async function collectProbe(
	rpc: Rpc,
	observed: { catalog: Catalog; frame: StreamValue | null },
	server: T3Server,
	request: BuilderProbeRequest,
): Promise<BuilderProbeResult> {
	const { catalog, frame } = observed;
	const environmentId = environmentFor(catalog, server);
	if (!environmentId) return { ok: false, reason: "unavailable" };
	const snapshot = completeBuilderSnapshot(frame);
	if (!snapshot) return { ok: false, reason: "load-unavailable" };
	const project = Array.isArray(snapshot.projects) ? projectFor(snapshot.projects, request.project) : undefined;
	if (!project) return { ok: false, reason: "project-unavailable" };
	const ids = threadIds(snapshot, request.residentThreadIds);
	if (!ids) return { ok: false, reason: "load-unavailable" };
	if (!(await workspaceAvailable(rpc, project, request.workspaceStrategy)))
		return { ok: false, reason: "project-unavailable" };
	const candidates = request.candidates.map((candidate) => candidateStatus(candidate, catalog, project.id));
	return {
		ok: true,
		environmentId,
		projectId: project.id,
		...ids,
		candidates,
		launches: request.candidates.map((candidate, i) =>
			candidates[i] === "eligible" ? builderLaunch(candidate, environmentId, project.id) : undefined,
		),
	};
}

/** The default shell subscription requests every thread, including older settled shells. */
function completeBuilderSnapshot(frame: StreamValue | null) {
	const snapshot = frame?.kind === "snapshot" ? frame.snapshot : undefined;
	if (!snapshot || !Array.isArray(snapshot.threads) || isPartialShell(snapshot) || snapshot.olderSettled) return;
	if (snapshot.archivedThreads !== undefined && !Array.isArray(snapshot.archivedThreads)) return;
	return snapshot;
}

export async function probeT3Builder(
	env: AdapterEnv,
	server: T3Server,
	request: BuilderProbeRequest,
): Promise<BuilderProbeResult> {
	try {
		const operate = modelConnection(env.conf, server.name);
		if (operate.origin !== server.origin) return { ok: false, reason: "unavailable" };
		// The optional dedicated token grants orchestration:read and filesystem:read, with the watcher using its own token.
		const token = env.readPrivate(
			typeof server.builderReadTokenFile === "string" ? server.builderReadTokenFile : server.tokenFile,
		);
		if (!token) return { ok: false, reason: "unavailable" };
		const rpc = await openWithin(connect, server.origin, token, PROBE_TIMEOUT_MS);
		try {
			const [config, shell] = await Promise.allSettled([
				builderCatalog(rpc, server.origin, token, operate.token),
				firstValue(rpc, "orchestration.subscribeShell", {}),
			]);
			if (config.status !== "fulfilled") return { ok: false, reason: "unavailable" };
			const frame = shell.status === "fulfilled" ? (shell.value as StreamValue | null) : null;
			return await collectProbe(rpc, { catalog: config.value, frame }, server, request);
		} finally {
			rpc.ws.close();
			rpc.fail();
		}
	} catch {
		return { ok: false, reason: "unavailable" };
	}
}
