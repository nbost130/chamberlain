/** Whether the Alert Desk's next turn runs where its command allowlist is enforced, asked of the server that will run it. */
import type { Adapter } from "../../core/adapter/adapter.ts";
import { cfg } from "../../core/config/layout.ts";
import { type PrepareFailure, preparationFailed } from "../../core/delivery/preflight.ts";
import { parseModels } from "../../core/llm/selection.ts";
import { within } from "../../core/within.ts";
import { modelConnection } from "./model.ts";
import { readModelCatalog } from "./model-catalog.ts";
import { ModelPreparationError, preflightFailure } from "./model-preflight.ts";
import { NOT_SENT, openWithin } from "./ping.ts";
import { connect } from "./rpc.ts";
import { verifyWebhook } from "./webhook-binding.ts";

/** The driver whose PreToolUse hooks block a call. A driver with no proven control is not it: the desk is held on any other. */
export const DESK_DRIVER = "claudeAgent";
const TIMEOUT_MS = 15_000;

/**
 * Throws unless the desk thread's next turn runs on that driver, as the server's own catalog names it now, and the wake's webhook, when there
 * is one, is bound to that thread on that server. T3's history is not asked: a provider can change drivers without a turn to show it.
 */
export async function verifyDeskDriver(conf: string, threadId: string | undefined, target?: string): Promise<void> {
	const server = parseModels(cfg(conf, "models")).desk?.server;
	if (!server || !threadId)
		throw new ModelPreparationError("config", "models.desk names no server for the desk thread");
	const { origin, token } = modelConnection(conf, server);
	const rpc = await openWithin(connect, origin, token, TIMEOUT_MS);
	try {
		if (target !== undefined) await verifyWebhook(rpc, origin, threadId, target);
		const { providers } = await readModelCatalog(rpc);
		const projection = (await within(
			rpc.request("orchestration.getThreadProjection", { threadId }),
			TIMEOUT_MS,
			"desk provider",
		)) as { thread?: { modelSelection?: { instanceId?: string } } };
		const instance = projection.thread?.modelSelection?.instanceId;
		const driver = instance && providers.find((p) => p.instanceId === instance)?.driver;
		if (driver !== DESK_DRIVER) throw new ModelPreparationError("policy", "the desk's provider enforces no allowlist");
	} finally {
		rpc.ws.close();
	}
}

async function refusal(
	conf: string,
	threadId: string,
	hooked: (id: string) => boolean,
): Promise<PrepareFailure | undefined> {
	try {
		await verifyDeskDriver(conf, threadId);
		return hooked(threadId) ? undefined : preparationFailed("policy");
	} catch (error) {
		return preflightFailure(error);
	}
}

type Answer = NonNullable<Adapter["answer"]>;
type Guard = { conf: string; desk: () => string | undefined; hooked: (threadId: string) => boolean };

/** Why nothing may be sent into this thread now: it is the desk's, and its next turn is not proven to be limited. */
const deskHeld = async (g: Guard, threadId: string): Promise<string | undefined> => {
	const held = threadId === g.desk() ? await refusal(g.conf, threadId, g.hooked) : undefined;
	return held && `${NOT_SENT}${held.reason} — ${held.detail}`;
};

/** Every other message into the desk's thread (a routed answer, a compaction) needs what its wake needs. */
export const guardDesk =
	<A extends unknown[], R>(
		g: Guard,
		send: (threadId: string, ...rest: A) => Promise<R>,
	): ((threadId: string, ...rest: A) => Promise<R | { ok: false; detail: string }>) =>
	async (threadId, ...rest) => {
		const detail = await deskHeld(g, threadId);
		return detail ? { ok: false, detail } : send(threadId, ...rest);
	};

/** So does an answer to a card of the desk's: an accepted goal starts a turn, and any other answer lets one go on. */
export const guardDeskAnswer =
	(g: Guard, answer: Answer): Answer =>
	async (card, choice, sig) => {
		const error = await deskHeld(g, card.threadId);
		return error ? { ok: false, kind: "refused", error, maybeSent: false } : answer(card, choice, sig);
	};
