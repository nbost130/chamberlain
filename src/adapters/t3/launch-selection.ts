/** Initial launches use central selections too, while T3's tool retains its own launch/permission contract. */
import type { LaunchRole } from "../../core/llm/selection.ts";
import { configuredThreadModel, modelConnection, validateThreadModel } from "./model.ts";
import { readModelCatalog } from "./model-catalog.ts";
import { openWithin } from "./ping.ts";
import { connect } from "./rpc.ts";

export async function launchSelection(conf: string, role: LaunchRole) {
	const c = configuredThreadModel(conf, role);
	const { origin, token } = modelConnection(conf, c.server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	try {
		const catalog = await readModelCatalog(rpc);
		validateThreadModel(c, catalog, role === "desk");
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
		throw Error(`models.${role}: launch selection unavailable; nothing launched`);
	} finally {
		rpc.ws.close();
	}
}
