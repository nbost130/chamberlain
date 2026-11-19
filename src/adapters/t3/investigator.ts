/**
 * Starts the overhead investigator: one new T3 thread in the operator's project, on the provider, model and effort the operator set in
 * `overhead.investigator.model`, with the brief as its first message.
 *
 * Everything it needs is an existing contract: the server's operate-token grant (`modelConnection`), the same preflight every launch uses
 * (`launchSelectionFor`: authenticated server, enabled provider, a model in its catalog, supported options), T3's `thread.create`, and the one
 * message builder (`messageCommand` in ping.ts, signed as the daemon). It chooses no model: the selection is the operator's, explicit, with no
 * default, and a provider that is down or out of quota means nothing is launched and the caller records the refusal (ISA.md, ISC-2 and ISC-8).
 *
 * The ids come from the investigation's id, so a repeat of the same launch is a repeat of the same commands, which T3 drops.
 */
import type { ThreadModel } from "../../core/llm/selection.ts";
import { within } from "../../core/within.ts";
import { launchSelectionFor } from "./launch-selection.ts";
import { modelConnection } from "./model.ts";
import { messageCommand, openWithin, stableId } from "./ping.ts";
import { connect } from "./rpc.ts";

export type InvestigatorLaunch = { seed: string; title: string; brief: string };

/** Pure: the `thread.create` command. */
export function createThreadCommand(a: {
	seed: string;
	projectId: string;
	title: string;
	modelSelection: { instanceId: string; model: string; options: { id: string; value: string | boolean }[] };
}): Record<string, unknown> {
	return {
		type: "thread.create",
		commandId: stableId(`create-cmd\0${a.seed}`),
		threadId: stableId(`create-thread\0${a.seed}`),
		projectId: a.projectId,
		title: a.title,
		modelSelection: a.modelSelection,
		runtimeMode: "full-access",
		interactionMode: "default",
		branch: null,
		worktreePath: null,
		createdBy: "agent",
		creationSource: "server",
	};
}

/** Creates the thread and starts it with the brief. Rejects, with nothing started, when the selection or the server is unusable. */
export async function launchInvestigator(
	conf: string,
	where: { model: ThreadModel; projectId: string },
	a: InvestigatorLaunch,
): Promise<{ threadId: string }> {
	const { server, launch } = await launchSelectionFor(conf, where.model, "overhead.investigator.model");
	const { origin, token } = modelConnection(conf, server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	try {
		const create = createThreadCommand({
			seed: a.seed,
			projectId: where.projectId,
			title: a.title,
			modelSelection: launch.modelSelection,
		});
		await within(rpc.request("orchestration.dispatchCommand", create), 15_000, "thread create");
		const threadId = create.threadId as string;
		await within(
			rpc.request(
				"orchestration.dispatchCommand",
				messageCommand({ threadId, text: a.brief, identity: "daemon", seed: `${a.seed}\0brief` }),
			),
			15_000,
			"investigator brief",
		);
		return { threadId };
	} finally {
		rpc.ws.close();
	}
}
