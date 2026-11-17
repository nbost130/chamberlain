/** No-tools inference. Provider failures never trigger a second provider or echo input/output. */
import { cfg, readSecret } from "../config/layout.ts";
import { CliError, MODEL_ID, parseReply, replyUsage, runClaude, type Usage } from "./cli.ts";
import { type ModelRole, parseModels, type ReaderModel } from "./selection.ts";

export type ReaderReply = Usage & { text: string; model: string };
export type ReaderInput = { system: string; text: string };

/** Usage survives an unsuccessful answer so the caller's budget still counts a billed request. */
export class ReaderError extends Error {
	constructor(
		message: string,
		readonly usage: Usage,
	) {
		super(message);
	}
}

export function selectedReader(conf: string, role: ModelRole): ReaderModel {
	const selected = parseModels(cfg(conf, "models"))[role];
	if (!selected) throw Error(`models.${role}: configure an explicit reader model`);
	if (selected.adapter === "t3") throw Error(`models.${role}: requires an isolated reader, not an agent thread`);
	return selected;
}

async function httpReader(c: ReaderModel, input: ReaderInput, conf: string): Promise<ReaderReply> {
	const key = c.keyFile ? readSecret(conf, c.keyFile) : undefined;
	if (c.keyFile && !key) throw Error("model credentials unavailable");
	let r: Response;
	try {
		r = await fetch(c.endpoint as string, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(c.timeoutMs),
			headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify({
				model: c.model,
				messages: [
					{ role: "system", content: input.system },
					{ role: "user", content: input.text },
				],
				...(c.effort ? { reasoning_effort: c.effort } : {}),
			}),
		});
	} catch {
		throw Error("model request failed (connection, redirect or timeout)");
	}
	if (!r.ok) {
		await r.body?.cancel();
		throw Error(`model request failed: HTTP ${r.status}`);
	}
	let body: {
		choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
		model?: unknown;
		usage?: { prompt_tokens?: unknown };
	};
	try {
		body = (await r.json()) as typeof body;
	} catch {
		throw Error("model response is not JSON");
	}
	const choice = body?.choices?.[0];
	if (choice?.finish_reason !== "stop" || choice.message?.tool_calls || typeof choice.message?.content !== "string")
		throw Error("model response is incomplete or requested tools");
	const tokens = body.usage?.prompt_tokens;
	return {
		text: choice.message.content,
		model: typeof body.model === "string" && MODEL_ID.test(body.model) ? body.model : c.model,
		...(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? { inputTokens: tokens } : {}),
	};
}

export async function readModel(c: ReaderModel, input: ReaderInput, conf: string): Promise<ReaderReply> {
	if (c.adapter === "openai-chat") return httpReader(c, input, conf);
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	const stdout = await runClaude({
		command: c.command as string,
		model: c.model,
		system: input.system,
		stdin: input.text,
		timeoutMs: c.timeoutMs,
		env,
		...(c.effort ? { effort: c.effort } : {}),
	}).catch((e) => {
		if (e instanceof CliError) throw new ReaderError("model process failed", e.usage);
		throw e;
	});
	const reply = parseReply("configured CLI", stdout);
	if (typeof reply.result !== "string" || (reply as { is_error?: boolean }).is_error)
		throw new ReaderError("model did not return an answer", replyUsage(reply));
	return { text: reply.result, model: c.model, ...replyUsage(reply) };
}
