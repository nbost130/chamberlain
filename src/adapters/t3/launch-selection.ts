/** Initial launches use central selections too, while T3's tool retains its own launch/permission contract. */
import type { LaunchRole, ThreadModel } from "../../core/llm/selection.ts";
import { configuredThreadModel, modelConnection, validateThreadModel } from "./model.ts";
import { readModelCatalog } from "./model-catalog.ts";
import { openWithin } from "./ping.ts";
import { connect } from "./rpc.ts";

/** A refusal is a rejection, as it always was: the role's selection is read inside the async function. */
export async function launchSelection(conf: string, role: LaunchRole) {
	return launchSelectionFor(conf, configuredThreadModel(conf, role), `models.${role}`, role === "desk");
}

/** The same preflight for a selection the caller already holds (the overhead investigator's own): server, provider, model and options all checked before anything launches. */
export async function launchSelectionFor(conf: string, c: ThreadModel, where: string, desk = false) {
	const { origin, token } = modelConnection(conf, c.server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	try {
		const catalog = await readModelCatalog(rpc);
		validateThreadModel(c, catalog, desk);
		const environmentId = catalog.environment?.environmentId;
		if (typeof environmentId !== "string" || !environmentId.trim())
			throw Error("configured server identity unavailable; nothing launched");
		return {
			server: c.server,
			launch: {
				environmentId,
				modelSelection: {
					instanceId: c.instanceId,
					model: c.model,
					options: Object.entries(c.options).map(([id, value]) => ({ id, value })),
				},
			},
		};
	} catch {
		throw Error(`${where}: launch selection unavailable; nothing launched`);
	} finally {
		rpc.ws.close();
	}
}
