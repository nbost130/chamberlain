import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadModel } from "../../core/llm/selection.ts";
import { LaunchRefused } from "../../core/overhead/investigator.ts";
import { modelServer } from "../../testing/model-server.ts";
import {
	createThreadCommand,
	inspectInvestigator,
	investigatorFor,
	investigatorThreadId,
	launchInvestigator,
	threadStateOf,
} from "./investigator.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
const setup = () => {
	const s = modelServer();
	s.state.strictThreads = true;
	servers.push(s);
	return s;
};
const dispatched = (s: ReturnType<typeof modelServer>) =>
	s.requests.filter((r) => r.tag === "orchestration.dispatchCommand").map((r) => r.payload);
const modelOf = (s: ReturnType<typeof modelServer>) => s.config.models.steward as ThreadModel;
const launch = { seed: "OV-123", title: "Overhead investigation 2026-11-18 OV-123", brief: "the brief" };
const where = (s: ReturnType<typeof modelServer>) => ({ model: modelOf(s), projectId: "proj-1" });

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
			threadId: investigatorThreadId("OV-1"),
		});
		expect(createThreadCommand({ seed: "OV-1", projectId: "proj", title: "T", modelSelection: sel })).toEqual(c);
		expect(investigatorThreadId("OV-2")).not.toBe(investigatorThreadId("OV-1"));
	});
});

describe("reading a projection", () => {
	test("says whether the brief is in the thread, whether a run is going and whether it is archived", () => {
		const brief = threadStateOf("OV-1", { messages: [] });
		expect(brief).toMatchObject({ exists: true, briefSent: false, active: false, archived: false });
		const s = setup();
		return launchInvestigator(s.conf, where(s), launch).then(async () => {
			const t = await inspectInvestigator(s.conf, modelOf(s), launch.seed);
			expect(t).toMatchObject({ exists: true, briefSent: true, threadId: investigatorThreadId(launch.seed) });
		});
	});

	test("a running run is active; an archived thread is archived", () => {
		expect(threadStateOf("x", { runs: [{ id: "r", status: "running" }] })).toMatchObject({ active: true });
		expect(threadStateOf("x", { runs: [{ id: "r", status: "completed" }] })).toMatchObject({ active: false });
		expect(threadStateOf("x", { thread: { archivedAt: "2026-11-18T00:00:00Z" } })).toMatchObject({ archived: true });
	});

	test("a seed T3 never made is absent; a read that fails any other way rejects, never reads as absent", async () => {
		const s = setup();
		expect(await inspectInvestigator(s.conf, modelOf(s), "OV-never")).toEqual({ exists: false });
		s.close();
		await expect(inspectInvestigator(s.conf, modelOf(s), "OV-never")).rejects.toThrow();
	});
});

describe("launching the investigator", () => {
	test("creates the thread on the operator's selection, then sends the brief into it as one queued daemon message", async () => {
		const s = setup();
		const { threadId } = await launchInvestigator(s.conf, where(s), launch);
		const sent = dispatched(s);
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

	test("a repeat of a completed launch sends nothing: the thread and its brief are already there", async () => {
		const s = setup();
		await launchInvestigator(s.conf, where(s), launch);
		const before = dispatched(s).length;
		await launchInvestigator(s.conf, where(s), launch);
		expect(dispatched(s)).toHaveLength(before);
	});

	test("a launch whose brief failed after the thread was made is finished by a repeat: no second thread, the same brief message", async () => {
		const s = setup();
		s.state.failSend = true;
		await expect(launchInvestigator(s.conf, where(s), launch)).rejects.not.toBeInstanceOf(LaunchRefused);
		s.state.failSend = false;
		await launchInvestigator(s.conf, where(s), launch);
		const sent = dispatched(s);
		expect(sent.filter((c) => c.type === "thread.create")).toHaveLength(1);
		const briefs = sent.filter((c) => c.type === "message.dispatch");
		expect(briefs).toHaveLength(2);
		expect(briefs[0]?.messageId).toBe(briefs[1]?.messageId);
		expect(await inspectInvestigator(s.conf, modelOf(s), launch.seed)).toMatchObject({ exists: true, briefSent: true });
	});

	test("refuses, as LaunchRefused with nothing launched, when the provider is unavailable, unauthenticated or out of quota", async () => {
		for (const fault of ["unavailable", "unauthenticated", "exhausted"] as const) {
			const s = setup();
			s.state[fault] = true;
			const err = await launchInvestigator(s.conf, where(s), launch).catch((e) => e);
			expect(err).toBeInstanceOf(LaunchRefused);
			expect(String(err.message)).toContain("overhead.investigator.model: launch selection unavailable");
			expect(dispatched(s)).toEqual([]);
		}
	});

	test("refuses a model or option the provider does not offer, and never falls back to another", async () => {
		const s = setup();
		const model = modelOf(s);
		for (const bad of [
			{ ...model, model: "not-offered" },
			{ ...model, options: { nope: "x" } },
		]) {
			const err = await launchInvestigator(s.conf, { model: bad, projectId: "p" }, launch).catch((e) => e);
			expect(err).toBeInstanceOf(LaunchRefused);
		}
		expect(dispatched(s)).toEqual([]);
	});

	test("refuses a server that is not configured, and a server that is not there", async () => {
		const s = setup();
		const elsewhere = { ...modelOf(s), server: "elsewhere" };
		const a = await launchInvestigator(s.conf, { model: elsewhere, projectId: "p" }, launch).catch((e) => e);
		expect(a).toBeInstanceOf(LaunchRefused);
		s.close();
		const b = await launchInvestigator(s.conf, where(s), launch).catch((e) => e);
		expect(b).toBeInstanceOf(LaunchRefused);
	});

	test("investigatorFor gives the tick both calls", async () => {
		const s = setup();
		const t = investigatorFor(s.conf, where(s));
		expect(await t.inspect(launch.seed)).toEqual({ exists: false });
		await t.launch(launch);
		expect(await t.inspect(launch.seed)).toMatchObject({ exists: true, briefSent: true });
	});
});
