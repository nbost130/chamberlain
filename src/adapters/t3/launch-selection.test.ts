import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { LAUNCH_ROLES } from "../../core/llm/selection.ts";
import { renderStartPrompt } from "../../core/sweep/sweep.ts";
import { modelServer } from "../../testing/model-server.ts";
import { launchSelection } from "./launch-selection.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
function setup() {
	const s = modelServer();
	servers.push(s);
	return s;
}

test("all initial launch roles bind the configured provider, effort and authenticated environment", async () => {
	for (const role of LAUNCH_ROLES) {
		const s = setup();
		for (const provider of ["other-provider", "replacement-provider"]) {
			s.state.instanceId = provider;
			writeFileSync(
				`${s.conf}/config.json`,
				JSON.stringify({
					...s.config,
					models: { [role]: { ...s.config.models.steward, instanceId: provider } },
				}),
			);
			const before = readFileSync(`${s.conf}/config.json`, "utf8");
			expect(await launchSelection(s.conf, role)).toEqual({
				server: "test",
				launch: {
					environmentId: s.state.environmentId!,
					modelSelection: {
						instanceId: provider,
						model: "chosen-model",
						options: [{ id: "reasoningEffort", value: "high" }],
					},
				},
			});
			expect(readFileSync(`${s.conf}/config.json`, "utf8")).toBe(before);
		}
		expect(s.requests.every((r) => r.tag === "subscribeServerConfig")).toBe(true);
	}
});

test("initial Desk launch preserves the same tool isolation refusals as later wakes", async () => {
	const s = setup();
	s.state.driver = "other-driver";
	await expect(launchSelection(s.conf, "desk")).rejects.toThrow();
	expect(s.sent()).toBe("");
	expect(s.selection().instanceId).toBe("old");
	s.state.driver = "claudeAgent";
	writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, alertDesk: { gatherer: "reader" } }));
	s.requests.length = 0;
	await expect(launchSelection(s.conf, "desk")).rejects.toThrow("gatherer");
	expect(s.requests).toHaveLength(0);
});

test("launch preflight refuses missing credentials, unsupported options, quota and unknown destinations without falling back", async () => {
	for (const failure of [
		"credentials",
		"option",
		"unavailable",
		"unauthenticated",
		"exhausted",
		"environment",
	] as const) {
		const s = setup();
		if (failure === "credentials") rmSync(`${s.conf}/secrets/test-token`);
		else if (failure === "environment") s.state.environmentId = undefined;
		else if (failure === "option") {
			s.config.models.steward.options.reasoningEffort = "unsupported";
			s.save();
		} else s.state[failure] = true;
		await expect(launchSelection(s.conf, "steward")).rejects.toThrow();
		expect(s.sent()).toBe("");
		expect(s.selection().instanceId).toBe("old");
	}
	const s = setup();
	await expect(launchSelection(s.conf, "butler")).rejects.toThrow("models.butler");
	expect(s.requests).toHaveLength(0);
});

test("models selection CLI prints only validated tool arguments, with no credential or model fallback", async () => {
	const s = setup();
	const child = Bun.spawn(["bun", new URL("../../models.ts", import.meta.url).pathname, "selection", "steward"], {
		env: { ...process.env, CHAMBERLAIN_CONF: s.conf },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(JSON.parse(stdout)).toEqual(await launchSelection(s.conf, "steward"));
	expect(stdout).not.toContain("test-only");
	expect(await new Response(child.stderr).text()).toBe("");
});

test("every shipped thread-launch template requires central preflight and exact initial selection", async () => {
	for (const [command, role] of [
		["steward-handoff", "steward"],
		["steward-butler", "butler"],
	]) {
		const text = await Bun.file(new URL(`../../../.claude/commands/${command}.md`, import.meta.url)).text();
		expect(text).toContain(`src/models.ts selection ${role}`);
		expect(text).toContain("`environmentId` and `modelSelection` copied exactly from `launch`, including every option");
		expect(text).not.toContain("orchestrator_capabilities");
		expect(text).not.toContain("no model");
		expect(text).not.toContain("Raise its effort");
		if (role === "butler") expect(text).toContain("reservation.acquired");
		else expect(text).toContain("no alternate machine or model");
	}
	for (const [path, role] of [
		["README.md", "steward"],
		["docs/decisions-thread-setup.md", "decisions"],
		["docs/alert-desk.md", "desk"],
		["docs/steward-sweep-prompt.md", "worker"],
	]) {
		const text = await Bun.file(new URL(`../../../${path}`, import.meta.url)).text();
		expect(text).toContain(`models selection ${role}`);
		expect(text).toContain("launch.environmentId");
		expect(text).toContain("launch.modelSelection");
		if (role === "worker") expect(text).toContain("models confirm");
		else expect(text).toContain("no alternate machine or model");
		expect(text).not.toContain("ToolSearch");
	}
	const handoff = await Bun.file(new URL("../../../.claude/commands/steward-handoff.md", import.meta.url)).text();
	expect(handoff).toContain("src/brief.ts start --mode <live|test>");
	expect(handoff).toContain("In TEST mode, stop here");
	expect(handoff).toContain("retain every existing trigger and watch");
	expect(handoff).not.toContain("exact contents of `docs/steward-start.md`");
});

test("handoff startup rendering preserves test isolation and expands live commands", async () => {
	const template = await Bun.file(new URL("../../../docs/steward-start.md", import.meta.url)).text();
	const opts = { conf: "/isolated/conf", compiled: false, repo: "/isolated/repo" };
	const probe = renderStartPrompt(template, { ...opts, mode: "test" });
	expect(probe).toContain("Do not run prepare or switch");
	expect(probe).toContain("Do not touch live secrets");
	expect(probe).toContain("--mode test");
	expect(probe).not.toContain("--live");
	const live = renderStartPrompt(template, { ...opts, mode: "live" });
	expect(live).toContain("--mode live");
	expect(live).not.toContain("{{");
});
