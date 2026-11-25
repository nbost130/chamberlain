/** A real local RPC server for testing model selection and message delivery together. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { messageCommand } from "../adapters/t3/ping.ts";

const dispatchType = messageCommand({ threadId: "fixture", text: "", identity: "steward" }).type;

export type BuilderShellThread = {
	id: string;
	projectId: string;
	status?: string | null;
	pendingRuntimeRequest?: { id: string; blocking: boolean };
	pendingBackgroundTasks?: { taskId: string; kind: string }[];
	archivedAt?: string;
	blockedOnThreadWait?: boolean;
};

type BuilderShell = {
	projects: { id: string; title: string; workspaceRoot: string }[];
	threads: BuilderShellThread[];
	archivedThreads?: BuilderShellThread[];
	partial?: boolean;
};

export function modelServer() {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-model-`);
	const requests: { tag: string; payload: any }[] = [];
	const tasks: any[] = [];
	const posts: string[] = [];
	const accepted: string[] = [];
	let selection: any = { instanceId: "old", model: "old", options: [] };
	/** Threads created by `thread.create`, with the messages dispatched into them: what strict mode's projection reads. */
	const made = new Map<string, { id: string }[]>();
	const state = {
		strictThreads: false,
		driver: "claudeAgent",
		instanceId: "other-provider",
		busy: false,
		startDuringCatalog: false,
		failSend: false,
		loseSendAck: false,
		ticketStatus: 200,
		projectionFailure: undefined as unknown,
		malformedProjectionFrame: undefined as string | undefined,
		error: "send failed",
		unavailable: false,
		ignoreSelection: false,
		unauthenticated: false,
		exhausted: false,
		quotaWindow: "seven_day",
		primaryModel: "chosen-model",
		backupAvailable: false,
		backupModel: "backup-model",
		legacyCatalogHangs: false,
		malformedCatalog: false,
		emptyCatalog: false,
		environmentId: crypto.randomUUID() as string | undefined,
		builderShell: undefined as BuilderShell | undefined,
		builderOverrides: {} as Record<string, { providerInstances: Record<string, { enabled: boolean }> }>,
		builderMissingGit: false,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req, server) {
			if (new URL(req.url).pathname.startsWith("/wake")) {
				posts.push(await req.text());
				return new Response(null, { status: 202 });
			}
			if (new URL(req.url).pathname === "/.well-known/t3/environment")
				return Response.json({ serverVersion: "0.1.9", orchestrationProtocolVersion: 2 });
			if (new URL(req.url).pathname === "/ws") {
				if (server.upgrade(req)) return;
				return new Response("upgrade failed", { status: 400 });
			}
			return Response.json({ ticket: "test-ticket" }, { status: state.ticketStatus });
		},
		websocket: {
			message(ws, data) {
				const r = JSON.parse(String(data));
				if (r._tag !== "Request") return;
				requests.push({ tag: r.tag, payload: r.payload });
				if (r.tag === "orchestration.subscribeShell" && state.builderShell) {
					const snapshot = { kind: "snapshot", snapshot: state.builderShell };
					ws.send(JSON.stringify({ _tag: "Chunk", requestId: r.id, values: [snapshot] }));
					return;
				}
				let value: any = {};
				if (r.tag === "filesystem.getMetadata") {
					const roots = state.builderShell?.projects.map((project) => project.workspaceRoot) ?? [];
					value = {
						entries: r.payload.paths.map((path: string) =>
							roots.includes(path) || (!state.builderMissingGit && roots.includes(path.replace(/\/\.git$/, "")))
								? { kind: "directory" }
								: null,
						),
					};
				}
				if (r.tag === "scheduledTasks.subscribe") {
					ws.send(JSON.stringify({ _tag: "Chunk", requestId: r.id, values: [{ tasks }] }));
					return;
				}
				if (r.tag === "server.getConfig" && state.legacyCatalogHangs) return;
				if (r.tag === "server.getConfig" || r.tag === "subscribeServerConfig")
					value = {
						environment: { environmentId: state.environmentId },
						settings: { projectSettingsOverrides: state.builderOverrides },
						providers: [
							{
								instanceId: "backup",
								driver: "alternative",
								enabled: state.backupAvailable,
								installed: true,
								models: [{ slug: state.backupModel }],
							},
							{
								instanceId: state.instanceId,
								driver: state.driver,
								enabled: !state.unavailable,
								installed: true,
								auth: { status: state.unauthenticated ? "unauthenticated" : "authenticated" },
								usageLimits: {
									windows: [
										{ id: state.quotaWindow, usedPercent: state.exhausted ? 100 : 0, resetsAt: "2099-01-01T00:00:00Z" },
									],
								},
								models: [
									{
										slug: state.primaryModel,
										capabilities: {
											optionDescriptors: [{ id: "reasoningEffort", type: "select", options: [{ id: "high" }] }],
										},
									},
								],
							},
						],
					};
				if (r.tag === "subscribeServerConfig" && !state.emptyCatalog) {
					if (state.startDuringCatalog) state.busy = true;
					const snapshot = state.malformedCatalog
						? { type: "snapshot", config: {} }
						: { type: "snapshot", config: value };
					ws.send(JSON.stringify({ _tag: "Chunk", requestId: r.id, values: [snapshot] }));
					return;
				}
				if (r.tag === "orchestration.getThreadProjection") {
					if (state.malformedProjectionFrame) {
						ws.send(state.malformedProjectionFrame);
						return;
					}
					if (state.projectionFailure) {
						ws.send(
							JSON.stringify({
								_tag: "Exit",
								requestId: r.id,
								exit: { _tag: "Failure", cause: state.projectionFailure },
							}),
						);
						return;
					}
					// Strict mode answers as T3 does: a thread nobody created has no projection; one that was has the messages sent into it.
					if (state.strictThreads && !made.has(r.payload.threadId)) {
						const cause = `No orchestration projection exists for thread ${r.payload.threadId}.`;
						ws.send(JSON.stringify({ _tag: "Exit", requestId: r.id, exit: { _tag: "Failure", cause } }));
						return;
					}
					value = {
						thread: { modelSelection: selection, archivedAt: null },
						runs: state.busy ? [{ id: "running", status: "running" }] : [],
						messages: made.get(r.payload.threadId) ?? [],
					};
				}
				if (r.payload.type === "thread.create") made.set(r.payload.threadId, []);
				if (r.payload.type === "thread.model-selection.set" && !state.ignoreSelection)
					selection = r.payload.modelSelection;
				if (r.payload.type === dispatchType && state.failSend) {
					ws.send(JSON.stringify({ _tag: "Exit", requestId: r.id, exit: { _tag: "Failure", cause: state.error } }));
					return;
				}
				if (r.payload.type === dispatchType) {
					accepted.push(r.payload.text);
					made.get(r.payload.threadId)?.push({ id: r.payload.messageId });
					if (state.loseSendAck) {
						ws.close();
						return;
					}
				}
				ws.send(JSON.stringify({ _tag: "Exit", requestId: r.id, exit: { _tag: "Success", value } }));
			},
		},
	});
	const model = {
		adapter: "t3",
		server: "test",
		instanceId: "other-provider",
		model: "chosen-model",
		options: { reasoningEffort: "high" },
	};
	const config = {
		servers: [{ name: "test", adapter: "t3", origin: server.url.origin, tokenFile: "test-token" }],
		web: { decisionsServer: { origin: server.url.origin, operateTokenFile: "test-token" } },
		threads: { decisions: "decisions-id", steward: "steward-id", desk: "desk-id" },
		models: { decisions: model, steward: model, desk: model },
	};
	mkdirSync(`${conf}/secrets`, { mode: 0o700 });
	writeFileSync(`${conf}/secrets/test-token`, "test-only", { mode: 0o600 });
	const save = () => writeFileSync(`${conf}/config.json`, JSON.stringify(config), { mode: 0o600 });
	save();
	return {
		conf,
		config,
		state,
		requests,
		tasks,
		posts,
		accepted,
		bindWake: (url: string, threadId: string) => {
			const existing = tasks.find((t) => t.webhook?.url === url);
			if (existing) {
				existing.threadId = threadId;
				return existing;
			}
			const task = { enabled: true, threadId, schedule: { type: "webhook" }, webhook: { url, path: "/wake" } };
			tasks.push(task);
			return task;
		},
		save,
		selection: () => selection,
		sent: () =>
			requests
				.filter((r) => r.payload.type === dispatchType)
				.map((r) => r.payload.text)
				.join("\n"),
		close: () => {
			server.stop(true);
			rmSync(conf, { recursive: true, force: true });
		},
	};
}
