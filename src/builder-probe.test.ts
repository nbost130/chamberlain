import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeAdapter } from "./adapters/index.ts";
import type { BuilderProbeRequest } from "./core/adapter/adapter.ts";
import { modelServer } from "./testing/model-server.ts";

const fixtures: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture() {
	const server = modelServer();
	fixtures.push(server);
	const entry = server.config.servers[0]!;
	const adapter = makeAdapter(entry, { conf: server.conf });
	const project = { id: "this-project", title: "Chamberlain", workspaceRoot: "/checkout/chamberlain" };
	const shell = { projects: [project], threads: [] };
	server.state.builderShell = shell;
	const candidate = { instanceId: "other-provider", model: "chosen-model", options: { reasoningEffort: "high" } };
	const request: BuilderProbeRequest = {
		project: project.title,
		workspaceStrategy: "worktree",
		residentThreadIds: ["resident"],
		candidates: [candidate],
	};
	return {
		...server,
		entry,
		project,
		candidate,
		probe: (overrides?: Partial<BuilderProbeRequest>) => adapter.probeBuilder!({ ...request, ...overrides }),
	};
}

test("builder probe counts work on the whole host and supplies the exact eligible launch arguments", async () => {
	const s = fixture();
	const projectId = s.project.id;
	s.state.builderShell!.threads = [
		{ id: "resident", status: "running", projectId },
		{ id: "direct", status: "running", projectId },
		{ id: "other-project", status: "queued", projectId: "different" },
		{ id: "human", status: "waiting", projectId },
		{ id: "thread-wait", status: "running", projectId, blockedOnThreadWait: true },
		{ id: "approval", status: "running", projectId, pendingRuntimeRequest: { id: "req", blocking: true } },
		{ id: "background", status: "completed", projectId, pendingBackgroundTasks: [{ taskId: "bg", kind: "command" }] },
		{ id: "monitor", status: "completed", projectId, pendingBackgroundTasks: [{ taskId: "m", kind: "monitor" }] },
		{ id: "archived", status: "running", projectId, archivedAt: "2026-05-01T12:00:00Z" },
	];
	s.state.builderShell!.archivedThreads = [{ id: "archived-separately", status: "running", projectId }];
	expect(await s.probe()).toEqual({
		ok: true,
		environmentId: s.state.environmentId!,
		projectId,
		activeThreadIds: ["direct", "other-project", "background"],
		observedThreadIds: [
			"archived-separately",
			"resident",
			"direct",
			"other-project",
			"human",
			"thread-wait",
			"approval",
			"background",
			"monitor",
			"archived",
		],
		candidates: ["eligible"],
		launches: [
			{
				environmentId: s.state.environmentId!,
				projectId,
				modelSelection: {
					instanceId: s.candidate.instanceId,
					model: s.candidate.model,
					options: [{ id: "reasoningEffort", value: "high" }],
				},
			},
		],
	});
});

test("builder candidates are assessed individually against model options, quotas and project overrides", async () => {
	const s = fixture();
	const c = s.candidate;
	const backup = { instanceId: "backup", model: "backup-model", options: {} };
	s.state.exhausted = true;
	s.state.backupAvailable = true;
	expect(
		await s.probe({
			candidates: [c, { ...c, model: "missing" }, { ...c, options: { reasoningEffort: "low" } }, backup],
		}),
	).toMatchObject({ ok: true, candidates: ["quota-exhausted", "model-unavailable", "unsupported-option", "eligible"] });
	s.state.builderOverrides[s.project.id] = { providerInstances: { backup: { enabled: false } } };
	expect(await s.probe({ candidates: [backup] })).toMatchObject({
		ok: true,
		candidates: ["project-override"],
		launches: [undefined],
	});
});

test("builder probe refuses ambiguous projects, missing worktree metadata, partial load and missing credentials", async () => {
	const s = fixture();
	s.state.builderShell!.projects.push({ ...s.project, id: "duplicate" });
	expect(await s.probe()).toEqual({ ok: false, reason: "project-unavailable" });
	s.state.builderMissingGit = true;
	expect(await s.probe({ project: s.project.id })).toEqual({ ok: false, reason: "project-unavailable" });
	expect(await s.probe({ project: s.project.id, workspaceStrategy: "root" })).toMatchObject({ ok: true });
	s.state.builderShell!.partial = true;
	expect(await s.probe({ project: s.project.id })).toEqual({ ok: false, reason: "load-unavailable" });
	rmSync(`${s.conf}/secrets/test-token`);
	expect(await s.probe()).toEqual({ ok: false, reason: "unavailable" });
});
