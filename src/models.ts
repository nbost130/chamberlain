/** One-time adoption of the pinned threads' existing selections; config.json owns them thereafter. */
import { modelConnection, validateThreadModel } from "./adapters/t3/model.ts";
import { openWithin } from "./adapters/t3/ping.ts";
import { connect } from "./adapters/t3/rpc.ts";
import { CONF } from "./core/config/config.ts";
import { importThreadModels, migrateLayout } from "./core/config/config-migrate.ts";
import { thread } from "./core/config/layout.ts";
import { readConfigFile } from "./core/config/layout-read.ts";
import { THREADS, type ThreadKey } from "./core/config/layout-schema.ts";
import { parseModels, type ThreadModel } from "./core/llm/selection.ts";
import { within } from "./core/within.ts";

export async function adoptThreadModels(conf: string, server: string, dryRun = false): Promise<string[]> {
	const current = readConfigFile(conf)?.models;
	if (current === null) return [];
	const { origin, token } = modelConnection(conf, server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	const found: Partial<Record<ThreadKey, { threadId: string; model: ThreadModel }>> = {};
	try {
		const catalog = await within(rpc.request("server.getConfig", {}), 15_000, "catalog");
		for (const role of THREADS) {
			if (current && Object.hasOwn(current, role)) continue;
			const id = thread(conf, role);
			if (!id) continue;
			const p = (await within(
				rpc.request("orchestration.getThreadProjection", { threadId: id }),
				15_000,
				"projection",
			)) as {
				thread?: {
					modelSelection?: { instanceId: string; model: string; options?: { id: string; value: string | boolean }[] };
				};
			};
			const s = p.thread?.modelSelection;
			if (!s) throw Error(`threads.${role}: existing model selection unavailable`);
			const model = parseModels({
				[role]: {
					adapter: "t3",
					server,
					instanceId: s.instanceId,
					model: s.model,
					options: Object.fromEntries((s.options ?? []).map((o) => [o.id, o.value])),
				},
			})[role] as ThreadModel;
			validateThreadModel(model, catalog as Parameters<typeof validateThreadModel>[1]);
			found[role] = { threadId: id, model };
		}
	} finally {
		rpc.ws.close();
	}
	const migration = migrateLayout(conf, { dryRun });
	if (migration.skipped || migration.plan.problems.length)
		throw Error("configuration migration needs attention; no thread models imported");
	return dryRun ? Object.keys(found) : importThreadModels(conf, found);
}

export async function main(argv = process.argv.slice(2)) {
	const [action, server, ...extra] = argv;
	if (action !== "import" || !server || extra.some((v) => v !== "--dry-run"))
		throw Error("usage: bun src/models.ts import <configured-server> [--dry-run]");
	const dryRun = extra.includes("--dry-run");
	console.log(
		`${dryRun ? "Would import" : "Imported"} existing thread selections into config.json: ${(await adoptThreadModels(CONF, server, dryRun)).join(", ") || "none (explicit choices preserved)"}`,
	);
}

if (import.meta.main) await main();
