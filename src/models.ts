/** One-time adoption of the pinned threads' existing selections; config.json owns them thereafter. */

import { parseArgs } from "node:util";
import { launchSelection } from "./adapters/t3/launch-selection.ts";
import { modelConnection, validateThreadModel } from "./adapters/t3/model.ts";
import { readModelCatalog } from "./adapters/t3/model-catalog.ts";
import { openWithin } from "./adapters/t3/ping.ts";
import { connect } from "./adapters/t3/rpc.ts";
import { type BuilderPlan, planBuilder, reservedPlan } from "./builder-selection.ts";
import { CONF, STATE } from "./core/config/config.ts";
import { importThreadModels, migrateLayout } from "./core/config/config-migrate.ts";
import { thread } from "./core/config/layout.ts";
import { readConfigFile } from "./core/config/layout-read.ts";
import { THREADS, type ThreadKey } from "./core/config/layout-schema.ts";
import { BuilderReservations } from "./core/llm/builder-reservations.ts";
import { parseBuilderProfiles } from "./core/llm/builder-routing.ts";
import { isLaunchRole, LAUNCH_ROLES, type LaunchRole, parseModels, type ThreadModel } from "./core/llm/selection.ts";
import { within } from "./core/within.ts";

export async function adoptThreadModels(conf: string, server: string, dryRun = false): Promise<string[]> {
	const current = readConfigFile(conf)?.models;
	if (current === null) return [];
	const { origin, token } = modelConnection(conf, server);
	const rpc = await openWithin(connect, origin, token, 15_000);
	const found: Partial<Record<ThreadKey, { threadId: string; model: ThreadModel }>> = {};
	try {
		const catalog = await readModelCatalog(rpc);
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

function builderFlags(args: string[]) {
	const { values } = parseArgs({
		args,
		options: {
			"t3-environment": { type: "string", multiple: true },
			project: { type: "string" },
			"request-id": { type: "string" },
			explain: { type: "boolean" },
		},
	});
	const project = values.project?.trim();
	const requestId = values["request-id"]?.trim();
	if (values["request-id"] !== undefined && (!requestId || requestId.length > 256))
		throw Error("--request-id must contain 1 to 256 characters");
	if (values.explain && requestId) throw Error("use --explain for preview or --request-id for launch");
	if (requestId && !project) throw Error("a builder request needs --project");
	return { project, requestId, explain: values.explain, t3Environments: values["t3-environment"] };
}

async function selection(role: LaunchRole, args: string[]) {
	if (role !== "worker" && role !== "butler") {
		if (args.length) throw Error("builder placement flags require worker or butler");
		return launchSelection(CONF, role);
	}
	const { project, requestId, explain, t3Environments } = builderFlags(args);
	const binding = JSON.stringify([role, project]);
	const reservations = new BuilderReservations<BuilderPlan>(STATE);
	const existing = requestId && reservations.get(requestId, binding);
	if (existing && existing.status !== "released") return reservedPlan(existing, false);
	const config = readConfigFile(CONF);
	const models = parseModels(config?.models);
	const selected = models[role];
	if (!selected || !("profile" in selected)) {
		const plan = await launchSelection(CONF, role);
		if (t3Environments?.includes(plan.launch.environmentId) === false)
			throw Error(`models.${role}: pinned environment is outside the launch session’s eligible environments`);
		return plan;
	}
	if (!project || !(requestId || explain))
		throw Error("builder profile requires --project <project> and either --request-id <stable-id> or --explain");
	const profile = parseBuilderProfiles(config?.builderProfiles).get(selected.profile);
	if (!profile) throw Error("unknown builder profile");
	return planBuilder({ t3Environments, role, conf: CONF, profile, models, project, reservations, binding, requestId });
}

export async function main(argv = process.argv.slice(2)) {
	const [action, server, ...extra] = argv;
	if (action === "selection" && server && isLaunchRole(server)) {
		console.log(JSON.stringify(await selection(server, extra)));
		return;
	}
	const [attemptId, threadId] = extra;
	if (action === "confirm" && server && attemptId && threadId && extra.length === 2) {
		new BuilderReservations(STATE).complete(server, attemptId, threadId);
		return;
	}
	if (action === "release" && server && attemptId && extra.length === 1) {
		new BuilderReservations(STATE).release(server, attemptId);
		return;
	}
	if (action !== "import" || !server || extra.some((v) => v !== "--dry-run"))
		throw Error(
			`usage: models import <configured-server> [--dry-run] | models selection <${LAUNCH_ROLES.join("|")}> [--project <project> --request-id <id>|--explain] | models confirm <request-id> <attempt-id> <thread-id> | models release <request-id> <attempt-id>`,
		);
	const dryRun = extra.includes("--dry-run");
	console.log(
		`${dryRun ? "Would import" : "Imported"} existing thread selections into config.json: ${(await adoptThreadModels(CONF, server, dryRun)).join(", ") || "none (explicit choices preserved)"}`,
	);
}

if (import.meta.main) await main();
