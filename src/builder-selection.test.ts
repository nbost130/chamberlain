import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { type BuilderShellThread, modelServer } from "./testing/model-server.ts";

const fixtures: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.close();
});

function host(name: string, title: string, threads: Omit<BuilderShellThread, "projectId">[]) {
	const fixture = modelServer();
	fixtures.push(fixture);
	const projectId = `project-${name}`;
	fixture.state.builderShell = {
		projects: [{ id: projectId, title, workspaceRoot: `/checkout/${name}` }],
		threads: threads.map((thread) => ({ ...thread, projectId })),
	};
	return { ...fixture, name, projectId, server: { ...fixture.config.servers[0]!, name } };
}

function cli(conf: string, state: string) {
	return async (...args: string[]) => {
		const child = Bun.spawn([process.execPath, new URL("./models.ts", import.meta.url).pathname, ...args], {
			env: { ...process.env, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	};
}

type ModelPlan = {
	server: string;
	launch: {
		environmentId: string;
		projectId?: string;
		modelSelection: { instanceId: string; model: string; options: { id: string; value: string | boolean }[] };
	};
	reservation: { acquired: boolean; attemptId: string; requestId: string; status: string; threadId?: string };
};
function plan<Plan = ModelPlan>(result: Awaited<ReturnType<ReturnType<typeof cli>>>): Plan {
	if (result.code !== 0) throw Error(result.stderr);
	if (result.stderr || result.stdout.includes("test-only")) throw Error("unexpected output from selection");
	return JSON.parse(result.stdout);
}

test("worker CLI balances live and reserved work across eligible hosts and retries the same placement", async () => {
	const main = host("main", "Chamberlain", [{ id: "steward-id", status: "running" }]);
	const builder = host("builder", "Chamberlain", [
		{ id: "worker-active", status: "running" },
		{ id: "worker-finished", status: "completed" },
	]);
	const other = host("other", "Other project", []);
	main.state.exhausted = true;
	main.state.backupAvailable = true;
	const primary = { instanceId: "other-provider", model: "chosen-model", options: { reasoningEffort: "high" } };
	const backup = { instanceId: "backup", model: "backup-model" };
	const hosts = [
		{ server: main.name, capacity: 1, candidates: [primary, backup] },
		{ server: builder.name, capacity: 2, candidates: [primary] },
		{ server: other.name, candidates: [primary] },
	];
	writeFileSync(
		`${main.conf}/config.json`,
		JSON.stringify({
			servers: [main.server, builder.server, other.server],
			web: { answerTokens: { main: "test-token", builder: "test-token", other: "test-token" } },
			models: { worker: { profile: "builders" }, steward: { ...main.config.models.steward, server: main.name } },
			threads: { steward: "steward-id" },
			builderProfiles: { builders: { hosts } },
		}),
	);
	const state = `${main.conf}/state`;
	const run = cli(main.conf, state);
	const selection = (...flags: string[]) => run("selection", "worker", "--project", "Chamberlain", ...flags);
	expect(plan(await selection("--explain", "--t3-environment", builder.state.environmentId!))).toMatchObject({
		server: builder.name,
		explanation: { hosts: { main: { ok: false, reason: "environment-not-linked" } } },
	});
	expect((await selection("--request-id", " ")).code).toBe(1);
	const preview = await selection("--explain");
	expect(plan(preview)).toMatchObject({
		server: main.name,
		launch: { projectId: main.projectId, modelSelection: backup },
		explanation: {
			hosts: { main: { active: 0 }, builder: { active: 1 }, other: { ok: false, reason: "project-unavailable" } },
			reasons: [
				{ server: main.name, candidateIndex: 0, reason: "quota-exhausted" },
				{ server: other.name, reason: "project-unavailable" },
			],
		},
	});
	expect(existsSync(`${state}/builder-reservations`)).toBe(false);
	for (const destination of [main, builder]) {
		expect(destination.requests).toContainEqual({
			tag: "filesystem.getMetadata",
			payload: { paths: [`/checkout/${destination.name}`, `/checkout/${destination.name}/.git`] },
		});
	}

	const plans = (await Promise.all(["job-a", "job-b"].map((id) => selection("--request-id", id)))).map(plan);
	expect(plans.map((chosen) => chosen.server).sort()).toEqual([builder.name, main.name]);
	for (const chosen of plans) expect(chosen.reservation).toMatchObject({ acquired: true, status: "pending" });
	expect(plans.find((chosen) => chosen.server === builder.name)?.launch).toMatchObject({
		projectId: builder.projectId,
		environmentId: builder.state.environmentId,
		modelSelection: {
			instanceId: primary.instanceId,
			model: primary.model,
			options: [{ id: "reasoningEffort", value: "high" }],
		},
	});

	const blocked = await selection("--explain");
	expect(blocked.code).toBe(1);
	expect(blocked.stdout).toBe("");
	expect(blocked.stderr).toContain("no eligible builder route");
	expect(blocked.stderr).toContain('"reason":"capacity"');
	expect(blocked.stderr).toContain('"reason":"project-unavailable"');
	expect(blocked.stderr).not.toContain("test-only");

	const original = plans[0]!;
	main.state.unavailable = true;
	const probeCount = fixtures.reduce((count, fixture) => count + fixture.requests.length, 0);
	expect(plan(await selection("--request-id", original.reservation.requestId))).toEqual({
		...original,
		reservation: { ...original.reservation, acquired: false },
	});
	expect(fixtures.reduce((count, fixture) => count + fixture.requests.length, 0)).toBe(probeCount);
	expect(fixtures.flatMap((fixture) => fixture.requests).some(({ payload }) => payload.type === "thread.create")).toBe(
		false,
	);
});

test("Sonnet quota falls back to Grok on Mac then Omar, and launch reservations retain their lifecycle across config changes", async () => {
	const mithrandir = host("Mithrandir", "Chamberlain", [
		{ id: "steward-id", status: "running" },
		{ id: "mithrandir-one", status: "running" },
		{ id: "mithrandir-two", status: "running" },
	]);
	const omar = host("Omar", "Chamberlain", [{ id: "omar-one", status: "running" }]);
	const mac = host("Mac", "Chamberlain", [
		{
			id: "mac-waiting-for-human",
			status: "waiting",
			pendingRuntimeRequest: { id: "human-input", blocking: true },
		},
	]);
	const servers = [mithrandir, omar, mac];
	const sonnet = { instanceId: "other-provider", model: "claude-sonnet-4-6" };
	const grok = { instanceId: "backup", model: "grok-4.6" };
	for (const { state } of servers) {
		state.primaryModel = sonnet.model;
		state.backupModel = grok.model;
		state.exhausted = true;
		state.quotaWindow = "seven_day_sonnet";
		state.backupAvailable = true;
	}
	const steward = { ...mithrandir.config.models.steward, server: mithrandir.name, model: sonnet.model };
	const config = {
		servers: servers.map(({ server }) => server),
		web: { answerTokens: Object.fromEntries(servers.map(({ name }) => [name, "test-token"])) },
		models: { worker: { profile: "builders" }, steward },
		threads: { steward: "steward-id" },
		builderProfiles: { builders: { hosts: servers.map(({ name }) => ({ server: name, candidates: [sonnet, grok] })) } },
	};
	const configPath = `${mithrandir.conf}/config.json`;
	writeFileSync(configPath, JSON.stringify(config));

	const run = cli(mithrandir.conf, `${mithrandir.conf}/state`);
	const selection = (...flags: string[]) => run("selection", "worker", "--project", "Chamberlain", ...flags);
	const reserve = async (id: string) => plan(await selection("--request-id", id));
	expect(plan(await selection("--explain"))).toMatchObject({
		server: mac.name,
		launch: { modelSelection: grok },
		explanation: {
			hosts: { Mithrandir: { active: 2 }, Omar: { active: 1 }, Mac: { active: 0 } },
			reasons: servers.map(({ name }) => ({ server: name, candidateIndex: 0, reason: "quota-exhausted" })),
		},
	});
	const macPlan = await reserve("mac-job");
	const omarPlan = await reserve("omar-job");
	expect(macPlan).toMatchObject({
		server: mac.name,
		launch: { environmentId: mac.state.environmentId, projectId: mac.projectId, modelSelection: grok },
	});
	expect(omarPlan).toMatchObject({
		server: omar.name,
		launch: { environmentId: omar.state.environmentId, projectId: omar.projectId, modelSelection: grok },
	});

	expect(await run("confirm", "mac-job", macPlan.reservation.attemptId, "created-on-mac")).toEqual({
		code: 0,
		stdout: "",
		stderr: "",
	});
	expect(await run("release", "omar-job", omarPlan.reservation.attemptId)).toEqual({ code: 0, stdout: "", stderr: "" });
	const reacquired = await reserve("omar-job");
	expect(reacquired).toMatchObject({ server: omar.name, reservation: { acquired: true, status: "pending" } });
	expect(reacquired.reservation.attemptId).not.toBe(omarPlan.reservation.attemptId);

	writeFileSync(
		configPath,
		JSON.stringify({ ...config, models: { ...config.models, worker: { adapter: "t3", server: omar.name, ...grok } } }),
	);
	expect(await reserve("mac-job")).toEqual({
		...macPlan,
		reservation: { ...macPlan.reservation, acquired: false, status: "confirmed", threadId: "created-on-mac" },
	});
	expect((await selection("--explain", "--t3-environment", mac.state.environmentId!)).code).toBe(1);
	expect(plan<Omit<ModelPlan, "reservation">>(await run("selection", "worker"))).toEqual({
		server: omar.name,
		launch: { environmentId: omar.state.environmentId!, modelSelection: { ...grok, options: [] } },
	});
});
