/**
 * Starts the overhead investigator: one new T3 thread in the operator's project, on the provider, model and effort the operator set in
 * `overhead.investigator.model`, with the brief as its first message.
 *
 * Everything it needs is an existing contract: the server's operate-token grant (`modelConnection`), the same preflight every launch uses
 * (`launchSelectionFor`: authenticated server, enabled provider, a model in its catalog, supported options), T3's `thread.create`, and the one
 * message builder (`messageCommand` in ping.ts, signed as the daemon). It chooses no model: the selection is the operator's, explicit, with no
 * default, and a provider that is down or out of quota means nothing is launched (ISA.md, ISC-2 and ISC-8).
 *
 * A launch whose response is lost must not become a second launch. Every id comes from the seed (the investigation's id): the thread's, the
 * create command's, the brief message's. `launch` first asks T3 what the seed already is: a thread with its brief is done, a thread without
 * it only needs the brief, and only a thread that does not exist is created. `inspect` is that same question for the tick's reconciliation.
 * A failure before any command was sent, or a reply from T3 refusing the create, is LaunchRefused (nothing happened); anything later is an
 * ordinary error, an outcome nobody knows.
 */
import type { ThreadModel } from "../../core/llm/selection.ts";
import { type Investigator, LaunchRefused, type ThreadState } from "../../core/overhead/investigator.ts";
import { within } from "../../core/within.ts";
import { launchSelectionFor } from "./launch-selection.ts";
import { modelConnection } from "./model.ts";
import { activeRunOf, messageCommand, openWithin, stableId } from "./ping.ts";
import { connect, type Rpc } from "./rpc.ts";

export type InvestigatorLaunch = { seed: string; title: string; brief: string };
type Where = { model: ThreadModel; projectId: string };

/** The id of the thread a seed becomes. */
export const investigatorThreadId = (seed: string): string => stableId(`create-thread\0${seed}`);

/** The id of the brief message a seed sends: the one `messageCommand` makes from `<seed>\0brief`, asked of it rather than rebuilt. */
const briefMessageId = (seed: string): string =>
	messageCommand({ threadId: "-", text: "", identity: "daemon", seed: `${seed}\0brief` }).messageId as string;

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
		threadId: investigatorThreadId(a.seed),
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

type Projection = {
	thread?: { archivedAt?: string | null };
	runs?: { id?: string; status?: string }[];
	messages?: { id?: string }[];
};

/** Pure: what a thread projection says about a seed's thread. */
export function threadStateOf(seed: string, p: Projection): ThreadState {
	return {
		exists: true,
		threadId: investigatorThreadId(seed),
		briefSent: (p.messages ?? []).some((m) => m.id === briefMessageId(seed)),
		active: activeRunOf(p.runs) !== undefined,
		archived: Boolean(p.thread?.archivedAt),
	};
}

/** T3's own words for a thread that was never created. Any other failure is not "absent": it is "cannot say". */
const NO_PROJECTION = "No orchestration projection exists for thread";

async function read(rpc: Pick<Rpc, "request">, seed: string): Promise<ThreadState> {
	try {
		const p = (await within(
			rpc.request("orchestration.getThreadProjection", { threadId: investigatorThreadId(seed) }),
			15_000,
			"investigator thread",
		)) as Projection;
		return threadStateOf(seed, p);
	} catch (e) {
		if (String(e instanceof Error ? e.message : e).includes(NO_PROJECTION)) return { exists: false };
		throw e;
	}
}

/** Opens the connection the launch and the inspection share. A failure here sent nothing. */
async function connectTo(conf: string, model: ThreadModel): Promise<Rpc> {
	try {
		const { origin, token } = modelConnection(conf, model.server);
		return await openWithin(connect, origin, token, 15_000);
	} catch (e) {
		throw new LaunchRefused(String(e instanceof Error ? e.message : e));
	}
}

/** The thread's current state in T3, by seed. Rejects when T3 cannot say. */
export async function inspectInvestigator(conf: string, model: ThreadModel, seed: string): Promise<ThreadState> {
	const { origin, token } = modelConnection(conf, model.server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	try {
		return await read(rpc, seed);
	} finally {
		rpc.ws.close();
	}
}

/** The create command, sent; a reply from T3 that refuses it means nothing was created, anything else is unknown. */
async function create(rpc: Rpc, command: Record<string, unknown>): Promise<void> {
	try {
		await within(rpc.request("orchestration.dispatchCommand", command), 15_000, "thread create");
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("rpc failure")) throw new LaunchRefused("T3 refused the thread");
		throw e;
	}
}

/**
 * Creates the thread if the seed has none and sends the brief if it is not there. Safe to repeat: every id comes from the seed. Rejects with
 * LaunchRefused when nothing was sent, and with another error when the outcome is unknown.
 */
export async function launchInvestigator(
	conf: string,
	where: Where,
	a: InvestigatorLaunch,
): Promise<{ threadId: string }> {
	let selection: Awaited<ReturnType<typeof launchSelectionFor>>;
	try {
		selection = await launchSelectionFor(conf, where.model, "overhead.investigator.model");
	} catch (e) {
		throw new LaunchRefused(String(e instanceof Error ? e.message : e));
	}
	const rpc = await connectTo(conf, where.model);
	try {
		const threadId = investigatorThreadId(a.seed);
		let state: ThreadState;
		try {
			state = await read(rpc, a.seed);
		} catch (e) {
			throw new LaunchRefused(String(e instanceof Error ? e.message : e));
		}
		if (state.exists && state.briefSent) return { threadId };
		if (!state.exists)
			await create(
				rpc,
				createThreadCommand({
					seed: a.seed,
					projectId: where.projectId,
					title: a.title,
					modelSelection: selection.launch.modelSelection,
				}),
			);
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

/** The investigator the daemon gives the tick, for one operator selection and project. */
export const investigatorFor = (conf: string, where: Where): Investigator => ({
	launch: (a) => launchInvestigator(conf, where, a),
	inspect: (seed) => inspectInvestigator(conf, where.model, seed),
});
