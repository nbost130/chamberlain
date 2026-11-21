/** Apply the operator's pinned-thread selection through T3's own provider-switch contract. */
import { cfg, readSecret, thread } from "../../core/config/layout.ts";
import type { ThreadKey } from "../../core/config/layout-schema.ts";
import { readServers } from "../../core/config/servers.ts";
import { QuotaExhausted } from "../../core/delivery/deliver.ts";
import { type LaunchRole, parseModels, type ThreadModel } from "../../core/llm/selection.ts";
import { withoutToken } from "../../core/ops/capability.ts";
import { within } from "../../core/within.ts";
import { type Catalog, readModelCatalog } from "./model-catalog.ts";
import { modelQuotaExhausted } from "./model-quota.ts";
import { activeRunOf, createRpcPing, openWithin, type PingResult } from "./ping.ts";
import { connect, type Rpc } from "./rpc.ts";
import { verifyWebhook } from "./webhook-binding.ts";

type Projection = {
	thread?: {
		projectId?: string;
		modelSelection?: { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] };
	};
	runs?: { id?: string; status?: string }[];
};
type Client = Pick<Rpc, "request" | "call">;

export function validateThreadModel(c: ThreadModel, catalog: Catalog, desk = false): void {
	const provider = catalog.providers.find((p) => p.instanceId === c.instanceId);
	if (!provider?.enabled || !provider.installed || provider.availability === "unavailable")
		throw Error("configured provider is unavailable");
	if (provider.auth?.status === "unauthenticated" || provider.status === "error")
		throw Error("configured provider needs authentication or repair");
	if (desk && provider.driver !== "claudeAgent")
		throw Error("Alert Desk requires an adapter enforcing its tool allowlist; this provider is unsupported");
	const model = provider.models.find((m) => m.slug === c.model);
	if (!model) throw Error("configured model is not in the provider catalog");
	for (const [id, value] of Object.entries(c.options)) {
		const d = model.capabilities?.optionDescriptors?.find((o) => o.id === id);
		if (!d || (d.type === "boolean" ? typeof value !== "boolean" : !d.options?.some((o) => o.id === value)))
			throw Error(`configured model does not support option ${id}`);
	}
	if (modelQuotaExhausted(provider, c.model)) throw new QuotaExhausted("configured provider quota is exhausted");
}

export function resolveThreadModel(
	selection: ThreadModel,
	catalog: Catalog,
	desk = false,
	projectId?: string,
): ThreadModel {
	const { fallbacks = [], ...primary } = selection;
	const overrides = projectId ? catalog.settings?.projectSettingsOverrides?.[projectId]?.providerInstances : undefined;
	if (overrides?.[primary.instanceId]?.enabled === false)
		throw Error("configured provider is disabled for this project");
	try {
		validateThreadModel(primary, catalog, desk);
		return primary;
	} catch (error) {
		if (!(error instanceof QuotaExhausted) || !fallbacks.length) throw error;
	}
	for (const option of fallbacks) {
		if (overrides?.[option.instanceId]?.enabled === false) continue;
		const candidate = { ...primary, ...option };
		try {
			validateThreadModel(candidate, catalog, desk);
			return candidate;
		} catch {
			// Rejected candidates cannot receive work. Continue only within the approved list.
		}
	}
	throw new QuotaExhausted("configured provider quota is exhausted and no approved backup is eligible");
}

function matches(p: Projection, c: ThreadModel): boolean {
	const s = p.thread?.modelSelection;
	if (!s || s.instanceId !== c.instanceId || s.model !== c.model) return false;
	const opts = Object.fromEntries((s.options ?? []).map((o) => [o.id, o.value]));
	return (
		Object.keys(opts).length === Object.keys(c.options).length &&
		Object.entries(c.options).every(([k, v]) => opts[k] === v)
	);
}

async function applyThreadModel(
	rpc: Client,
	threadId: string,
	configured: ThreadModel,
	desk: boolean,
): Promise<ThreadModel> {
	const request = (method: string, params: unknown) => within(rpc.request(method, params), 15_000, "model selection");
	const read = async () => (await request("orchestration.getThreadProjection", { threadId })) as Projection;
	const catalog = await readModelCatalog(rpc);
	const before = await read();
	const c = resolveThreadModel(configured, catalog, desk, before.thread?.projectId);
	if (matches(before, c)) return c;
	if (activeRunOf(before.runs)) throw Error("thread is busy; model switch deferred until it is idle");
	await request("orchestration.dispatchCommand", {
		type: "thread.model-selection.set",
		commandId: crypto.randomUUID(),
		threadId,
		modelSelection: {
			instanceId: c.instanceId,
			model: c.model,
			options: Object.entries(c.options).map(([id, value]) => ({ id, value })),
		},
	});
	if (!matches(await read(), c)) throw Error("thread model selection was not confirmed");
	return c;
}

/** A configured server uses only its existing operate-token grant; no new credential store. */
export function modelConnection(
	conf: string,
	name: string,
): { origin: string; token: string; operateTokenFile: string } {
	const server = readServers(conf)?.find((s) => s.name === name);
	if (server?.adapter !== "t3" || typeof server.origin !== "string") throw Error("model server is not configured");
	const web = cfg(conf, "web") as
		| { decisionsServer?: { origin: string; operateTokenFile: string }; answerTokens?: Record<string, string> }
		| undefined;
	const file =
		web?.decisionsServer?.origin === server.origin ? web.decisionsServer.operateTokenFile : web?.answerTokens?.[name];
	if (!file) throw Error("model selection needs an existing web operate-token grant for its server");
	const token = readSecret(conf, file);
	if (!token) throw Error("model selection operate token unavailable");
	return { origin: server.origin, token, operateTokenFile: file };
}

/** Whether a gatherer runs the Alert Desk: then Chamberlain selects no model for the desk thread. */
export const deskHasGatherer = (conf: string): boolean =>
	Boolean((cfg(conf, "alertDesk") as { gatherer?: unknown } | undefined)?.gatherer);

export function configuredThreadModel(conf: string, role: LaunchRole): ThreadModel {
	if (role === "desk" && deskHasGatherer(conf))
		throw Error("Alert Desk gatherer has no centrally configured execution adapter; selection is unsupported");
	const c = parseModels(cfg(conf, "models"))[role];
	if (c?.adapter !== "t3") throw Error(`models.${role}: configure a T3 provider and model`);
	return c;
}

export async function configureThread(conf: string, role: ThreadKey, targetThread?: string, targetUrl?: string) {
	const configured = configuredThreadModel(conf, role);
	const id = targetThread ?? thread(conf, role);
	if (!id) throw Error(`threads.${role}: no thread configured`);
	const { origin, token, operateTokenFile } = modelConnection(conf, configured.server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	let c: ThreadModel;
	try {
		if (targetUrl !== undefined) await verifyWebhook(rpc, origin, id, targetUrl);
		c = await applyThreadModel(rpc, id, configured, role === "desk");
	} finally {
		rpc.ws.close();
	}
	return {
		threadId: id,
		modelSelection: {
			instanceId: c.instanceId,
			model: c.model,
			options: Object.entries(c.options).map(([id, value]) => ({ id, value })),
		},
		server: { name: c.server, origin, operateTokenFile, tokenFile: operateTokenFile },
	};
}

/** Selection and sending use the same configured server, not whichever CLI is local. */
export async function configuredPing(
	conf: string,
	role: ThreadKey,
	text: string,
	redactTokens: (string | undefined)[] = [],
): Promise<PingResult> {
	try {
		const { threadId, server, modelSelection } = await configureThread(conf, role);
		const scrubError = (message: string) =>
			redactTokens.reduce<string>((out, token) => withoutToken(out, token), message);
		return await createRpcPing({ conf, server, modelSelection, scrubError })(threadId, text, crypto.randomUUID());
	} catch {
		return { ok: false, detail: `models.${role}: selection unavailable; nothing sent` };
	}
}
