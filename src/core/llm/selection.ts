/** Explicit model selections in config.json. No model, provider or billing defaults. */
import { object, required } from "../config/config-fields.ts";

export const LAUNCH_ROLES = ["steward", "decisions", "desk", "butler", "worker"] as const;
export type LaunchRole = (typeof LAUNCH_ROLES)[number];
export const isLaunchRole = (role: string): role is LaunchRole => LAUNCH_ROLES.some((r) => r === role);
const MODEL_ROLES = [...LAUNCH_ROLES, "classifier", "mailDriver", "mailEscalate", "mailTop"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
type Options = Record<string, string | boolean>;
export type ThreadModel = { adapter: "t3"; server: string; instanceId: string; model: string; options: Options };
export type ReaderModel = {
	adapter: "claude-cli" | "openai-chat";
	model: string;
	command?: string;
	endpoint?: string;
	keyFile?: string;
	effort?: string;
	timeoutMs: number;
	accountingUsdPerCall?: number;
};
type ModelSelection = ThreadModel | ReaderModel;
export type ModelSelections = Partial<Record<ModelRole, ModelSelection>>;

function options(raw: unknown, where: string): Options {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`${where}: expected an object`);
	for (const [k, v] of Object.entries(raw))
		if (!k.trim() || !(typeof v === "boolean" || (typeof v === "string" && v.trim())))
			throw Error(`${where}: options must have non-empty names and string or boolean values`);
	return raw as Options;
}

function reader(o: Record<string, unknown>, where: string): ReaderModel {
	const adapter = o.adapter;
	if (adapter !== "claude-cli" && adapter !== "openai-chat") throw Error(`${where}: unsupported adapter`);
	object(o, where, [
		"adapter",
		"model",
		"command",
		"endpoint",
		"keyFile",
		"effort",
		"timeoutMs",
		"accountingUsdPerCall",
	]);
	const model = required(o, "model", where);
	const timeoutMs = o.timeoutMs ?? 60_000;
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
		throw Error(`${where}: timeoutMs must be a positive integer`);
	const effort = o.effort === undefined ? undefined : required(o, "effort", where);
	if (adapter === "claude-cli") {
		if ([o.endpoint, o.keyFile, o.accountingUsdPerCall].some((v) => v !== undefined))
			throw Error(`${where}: CLI cannot use HTTP settings`);
		if (![undefined, "low", "medium", "high", "max"].includes(effort)) throw Error(`${where}: unsupported effort`);
		return { adapter, model, command: required(o, "command", where), timeoutMs, ...(effort ? { effort } : {}) };
	}
	return {
		adapter,
		model,
		timeoutMs,
		...httpSettings(o, where),
		...accounting(o, where),
		...(effort ? { effort } : {}),
	};
}

function accounting(o: Record<string, unknown>, where: string): Pick<ReaderModel, "accountingUsdPerCall"> {
	const cost = o.accountingUsdPerCall;
	if (cost === undefined) return {};
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
		throw Error(`${where}: accountingUsdPerCall must be a non-negative finite number`);
	return { accountingUsdPerCall: cost };
}

function httpSettings(o: Record<string, unknown>, where: string): Pick<ReaderModel, "endpoint" | "keyFile"> {
	if (o.command !== undefined) throw Error(`${where}: HTTP cannot use a command`);
	const endpoint = required(o, "endpoint", where);
	const url = new URL(endpoint);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!(
			url.protocol === "https:" ||
			(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		)
	)
		throw Error(`${where}: endpoint must be HTTPS (HTTP allowed on loopback), without credentials, query or fragment`);
	const keyFile = o.keyFile === undefined ? undefined : required(o, "keyFile", where);
	if (keyFile && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(keyFile))
		throw Error(`${where}: keyFile must be a plain filename`);
	return { endpoint, ...(keyFile ? { keyFile } : {}) };
}

export function parseModels(raw: unknown): ModelSelections {
	if (raw === undefined || raw === null) return {};
	const rows = object(raw, "models", MODEL_ROLES);
	const result: ModelSelections = {};
	for (const [role, rawSelection] of Object.entries(rows)) {
		if (rawSelection === null) continue;
		const where = `models.${role}`;
		const o = object(rawSelection, where, [
			"adapter",
			"model",
			"server",
			"instanceId",
			"options",
			"command",
			"endpoint",
			"keyFile",
			"effort",
			"timeoutMs",
			"accountingUsdPerCall",
		]);
		const pinned = isLaunchRole(role);
		if (pinned) {
			object(o, where, ["adapter", "server", "instanceId", "model", "options"]);
			if (o.adapter !== "t3") throw Error(`${where}: pinned threads require the t3 adapter`);
			result[role as ModelRole] = {
				adapter: "t3",
				server: required(o, "server", where),
				instanceId: required(o, "instanceId", where),
				model: required(o, "model", where),
				options: options(o.options, where),
			};
		} else result[role as ModelRole] = reader(o, where);
	}
	return result;
}
