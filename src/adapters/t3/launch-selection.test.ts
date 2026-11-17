import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("handoff and Butler launch arguments bind the configured provider, effort and authenticated environment", async () => {
	for (const role of ["steward", "butler"] as const) {
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
		expect(text).toContain("no alternate machine or model");
	}
});
