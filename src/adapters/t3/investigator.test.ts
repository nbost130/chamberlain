import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadModel } from "../../core/llm/selection.ts";
import { modelServer } from "../../testing/model-server.ts";
import { createThreadCommand, launchInvestigator } from "./investigator.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
const setup = () => {
	const s = modelServer();
	servers.push(s);
	return s;
};
const commands = (s: ReturnType<typeof modelServer>) =>
	s.requests.filter((r) => r.tag === "orchestration.dispatchCommand").map((r) => r.payload);
const launch = { seed: "OV-123", title: "Overhead investigation 2026-11-18 OV-123", brief: "the brief" };

describe("the thread.create command", () => {
	const sel = { instanceId: "p", model: "m", options: [{ id: "effort", value: "high" }] };
	test("creates a titled thread in the given project on the given selection, signed as the daemon, with ids fixed by the seed", () => {
		const c = createThreadCommand({ seed: "OV-1", projectId: "proj", title: "T", modelSelection: sel });
		expect(c).toMatchObject({
			type: "thread.create",
			projectId: "proj",
			title: "T",
			modelSelection: sel,
			branch: null,
			worktreePath: null,
			createdBy: "agent",
			creationSource: "server",
		});
		expect(createThreadCommand({ seed: "OV-1", projectId: "proj", title: "T", modelSelection: sel })).toEqual(c);
		expect(createThreadCommand({ seed: "OV-2", projectId: "proj", title: "T", modelSelection: sel }).threadId).not.toBe(
			c.threadId,
		);
	});
});

describe("launching the investigator", () => {
	test("creates the thread on the operator's selection, then sends the brief into it as one queued daemon message", async () => {
		const s = setup();
		const model = s.config.models.steward as ThreadModel;
		const { threadId } = await launchInvestigator(s.conf, { model, projectId: "proj-1" }, launch);
		const sent = commands(s);
		expect(sent.map((c) => c.type)).toEqual(["thread.create", "message.dispatch"]);
		expect(sent[0]).toMatchObject({
			projectId: "proj-1",
			title: launch.title,
			threadId,
			modelSelection: {
				instanceId: "other-provider",
				model: "chosen-model",
				options: [{ id: "reasoningEffort", value: "high" }],
			},
		});
		expect(sent[1]).toMatchObject({
			threadId,
			text: "the brief",
			createdBy: "agent",
			creationSource: "server",
			dispatchMode: { type: "queue_after_active" },
		});
	});

	test("a repeat of the same launch sends the same ids, which T3 drops", async () => {
		const s = setup();
		const model = s.config.models.steward as ThreadModel;
		await launchInvestigator(s.conf, { model, projectId: "p" }, launch);
		await launchInvestigator(s.conf, { model, projectId: "p" }, launch);
		const [a, b, c, d] = commands(s);
		expect([a?.commandId, a?.threadId]).toEqual([c?.commandId, c?.threadId]);
		expect([b?.commandId, b?.messageId]).toEqual([d?.commandId, d?.messageId]);
	});

	test("refuses, with nothing launched, when the provider is unavailable, unauthenticated or out of quota", async () => {
		for (const fault of ["unavailable", "unauthenticated", "exhausted"] as const) {
			const s = setup();
			s.state[fault] = true;
			const model = s.config.models.steward as ThreadModel;
			await expect(launchInvestigator(s.conf, { model, projectId: "p" }, launch)).rejects.toThrow(
				"overhead.investigator.model: launch selection unavailable; nothing launched",
			);
			expect(commands(s)).toEqual([]);
		}
	});

	test("refuses a model or option the provider does not offer, and never falls back to another", async () => {
		const s = setup();
		const model = s.config.models.steward as ThreadModel;
		await expect(
			launchInvestigator(s.conf, { model: { ...model, model: "not-offered" }, projectId: "p" }, launch),
		).rejects.toThrow("nothing launched");
		await expect(
			launchInvestigator(s.conf, { model: { ...model, options: { nope: "x" } }, projectId: "p" }, launch),
		).rejects.toThrow("nothing launched");
		expect(commands(s)).toEqual([]);
	});

	test("refuses a server that is not configured", async () => {
		const s = setup();
		const model = s.config.models.steward as ThreadModel;
		await expect(
			launchInvestigator(s.conf, { model: { ...model, server: "elsewhere" }, projectId: "p" }, launch),
		).rejects.toThrow();
		expect(commands(s)).toEqual([]);
	});
});
