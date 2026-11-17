/** Initial launches use central selections too, while T3's tool retains its own launch/permission contract. */
import { cfg } from "../../core/config/layout.ts";
import { parseModels } from "../../core/llm/selection.ts";
import { modelConnection, validateThreadModel } from "./model.ts";
import { readModelCatalog } from "./model-catalog.ts";
import { openWithin } from "./ping.ts";
import { connect } from "./rpc.ts";

export async function launchSelection(conf: string, role: "steward" | "butler") {
	const c = parseModels(cfg(conf, "models"))[role];
	if (c?.adapter !== "t3") throw Error(`models.${role}: configure a T3 provider and model before launching`);
	const { origin, token } = modelConnection(conf, c.server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	try {
		const catalog = await readModelCatalog(rpc);
		validateThreadModel(c, catalog);
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
