import { afterEach, expect, test } from "bun:test";
import { modelServer } from "../../testing/model-server.ts";
import { guardDesk } from "./desk-policy.ts";
import { configuredPing, configureThread } from "./model.ts";
import { modelWake } from "./model-wake.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});
function setup() {
	const s = modelServer();
	servers.push(s);
	return s;
}

test("every pinned role selects the configured provider, model and options through the real RPC transport", async () => {
	for (const role of ["decisions", "steward", "desk"] as const) {
		const s = setup();
		await configureThread(s.conf, role);
		expect(s.selection()).toEqual({
			instanceId: "other-provider",
			model: "chosen-model",
			options: [{ id: "reasoningEffort", value: "high" }],
		});
		expect(s.requests.find((r) => r.payload.type === "thread.model-selection.set")?.payload.threadId).toBe(
			s.config.threads[role],
		);
	}
});

test("unsupported options, unavailable providers, busy switches, and unconfirmed selections never send", async () => {
	for (const failure of ["option", "unavailable", "busy", "ignoreSelection", "exhausted", "unauthenticated"] as const) {
		const s = setup();
		if (failure === "option") {
			s.config.models.decisions.options.reasoningEffort = "unsupported";
			s.save();
		} else s.state[failure] = true;
		expect((await configuredPing(s.conf, "decisions", "must not send")).ok).toBe(false);
		expect(s.sent()).toBe("");
	}
});

test("Decisions dispatch carries the validated selection, without relying on a later thread default", async () => {
	const s = setup();
	s.state.driver = "grok";
	expect((await configuredPing(s.conf, "decisions", "render the queue")).ok).toBe(true);
	expect(s.requests.at(-1)?.payload.modelSelection).toEqual(s.selection());
});

test("unrelated full-config discovery cannot block model selection", async () => {
	const s = setup();
	s.state.legacyCatalogHangs = true;
	expect((await configuredPing(s.conf, "decisions", "selected provider remains usable")).ok).toBe(true);
	expect(s.requests.some((r) => r.tag === "server.getConfig")).toBe(false);
	expect(s.requests.find((r) => r.tag === "subscribeServerConfig")?.payload).toEqual({
		workspaceSnapshotsOnDemand: true,
		providerCatalogsOnDemand: true,
	});
});

test("empty and malformed catalog snapshots never select or send", async () => {
	for (const failure of ["emptyCatalog", "malformedCatalog"] as const) {
		const s = setup();
		s.state[failure] = true;
		expect((await configuredPing(s.conf, "decisions", "must not send")).ok).toBe(false);
		expect(s.selection().instanceId).toBe("old");
		expect(s.sent()).toBe("");
	}
});

test("Alert Desk rejects providers without the existing command-hook boundary and unmanaged gatherers", async () => {
	const s = setup();
	s.state.driver = "grok";
	await expect(configureThread(s.conf, "desk")).rejects.toThrow("tool allowlist");
	s.state.driver = "claudeAgent";
	const { writeFileSync } = await import("node:fs");
	writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, alertDesk: { gatherer: "reader" } }));
	await expect(configureThread(s.conf, "desk")).rejects.toThrow("gatherer");
	expect(s.requests.some((r) => r.payload.type === "thread.model-selection.set")).toBe(false);
	expect(s.sent()).toBe("");
});

test("Steward prepares the committed generation even while the config thread mirror is stale", async () => {
	const s = setup();
	await configureThread(s.conf, "steward", "committed-generation-thread");
	expect(s.requests.find((r) => r.payload.type === "thread.model-selection.set")?.payload.threadId).toBe(
		"committed-generation-thread",
	);
	expect(s.config.threads.steward).toBe("steward-id");
});

test("a matching selection is idempotent and failures never silently select a different provider", async () => {
	const s = setup();
	await configureThread(s.conf, "decisions");
	await configureThread(s.conf, "decisions");
	expect(s.requests.filter((r) => r.payload.type === "thread.model-selection.set").length).toBe(1);
	s.config.models.decisions.instanceId = "missing";
	s.save();
	expect((await configuredPing(s.conf, "decisions", "must not send")).ok).toBe(false);
	expect(s.selection().instanceId).toBe("other-provider");
});

test("wake preflight failure sends nothing and recovers after an operator selection change", async () => {
	const s = setup();
	const url = `${s.config.servers[0]!.origin}/wake`;
	s.bindWake(url, "steward-id");
	let calls = 0;
	const wake = modelWake(
		{
			ready: () => true,
			send: async () => {
				calls++;
				return { ok: true };
			},
		},
		s.conf,
		"steward",
	);
	s.state.unavailable = true;
	expect(await wake.prepare!(undefined, url)).toMatchObject({ ok: false, reason: "config" });
	expect(calls).toBe(0);
	s.state.unavailable = false;
	expect(await wake.prepare!(undefined, url)).toEqual({ ok: true });
	await wake.send("id", "message");
	expect(calls).toBe(1);
});

test("a desk run by a gatherer has no model to select: its wake needs its webhook, its driver and its hook proven", async () => {
	const s = setup();
	const config = s.config as Record<string, unknown>;
	config.alertDesk = { gatherer: { command: ["gather"] } };
	s.save();
	const transport = { ready: () => true, send: async () => ({ ok: true }) };
	const asked: unknown[] = [];
	let hooked = true;
	const desk = modelWake({ ...transport }, s.conf, "desk", (id) => {
		asked.push(id);
		return hooked;
	});
	const url = "https://relay.example.test/hooks/desk";
	s.selection().instanceId = s.state.instanceId;
	s.bindWake(url, "another-thread");
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "config" });
	s.bindWake(url, "desk-id");
	expect(await desk.prepare!("desk-id", url)).toEqual({ ok: true });
	expect(await desk.prepare!(undefined, url)).toEqual({ ok: true });
	for (const driver of ["cursor", "codex", "anything-new"]) {
		s.state.driver = driver;
		expect(await desk.prepare!("desk-id", url), driver).toMatchObject({ ok: false, reason: "policy" });
	}
	s.state.driver = "claudeAgent";
	s.selection().instanceId = "not-in-the-catalog";
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "policy" });
	s.selection().instanceId = s.state.instanceId;
	s.state.ticketStatus = 503;
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "unreachable" });
	s.state.ticketStatus = 200;
	hooked = false;
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "policy" });
	expect(asked).toEqual(["desk-id", "desk-id", "desk-id"]);
	expect(await modelWake({ ...transport }, s.conf, "desk").prepare!("desk-id", url)).toMatchObject({
		reason: "policy",
	});
	expect(await desk.prepare!("desk-id", undefined)).toMatchObject({ ok: false, reason: "config" });
	expect(s.requests.some((r) => r.payload.type === "thread.model-selection.set")).toBe(false);
	await expect(configureThread(s.conf, "desk")).rejects.toThrow("gatherer");
	delete (s.config.models as Record<string, unknown>).desk;
	s.save();
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "config" });
	const steward = modelWake({ ...transport }, s.conf, "steward");
	const wakeUrl = `${s.config.servers[0]!.origin}/wake`;
	s.bindWake(wakeUrl, "steward-id");
	expect(await steward.prepare!("steward-id", wakeUrl)).toEqual({ ok: true });
});

test("any other message into the desk's thread needs the same proof, and one to another thread needs none", async () => {
	const s = setup();
	s.selection().instanceId = s.state.instanceId;
	const sent: unknown[][] = [];
	let hooked = true;
	const send = guardDesk(
		{ conf: s.conf, desk: () => "desk-id", hooked: () => hooked },
		async (threadId: string, text: string, seed: string) => {
			sent.push([threadId, text, seed]);
			return { ok: true, detail: "" };
		},
	);
	expect(await send("desk-id", "hello", "seed")).toEqual({ ok: true, detail: "" });
	hooked = false;
	expect(await send("desk-id", "held", "seed")).toMatchObject({ ok: false });
	hooked = true;
	s.state.driver = "cursor";
	const held = await send("desk-id", "held", "seed");
	expect(held.ok).toBe(false);
	expect(held.detail).toContain("policy");
	const requests = s.requests.length;
	expect(await send("other-id", "hello", "seed")).toEqual({ ok: true, detail: "" });
	expect(s.requests.length).toBe(requests);
	expect(sent.map((x) => x[1])).toEqual(["hello", "hello"]);
});

test("a desk with its own model needs the allowlist enforced after its model is selected", async () => {
	const s = setup();
	const url = `${s.config.servers[0]!.origin}/wake`;
	s.bindWake(url, "desk-id");
	const transport = { ready: () => true, send: async () => ({ ok: true }) };
	let selectedFirst = false;
	const desk = modelWake({ ...transport }, s.conf, "desk", () => {
		selectedFirst = s.selection().instanceId === "other-provider";
		return false;
	});
	expect(await desk.prepare!("desk-id", url)).toMatchObject({ ok: false, reason: "policy" });
	expect(selectedFirst).toBe(true);
	expect(await modelWake({ ...transport }, s.conf, "desk", () => true).prepare!("desk-id", url)).toEqual({ ok: true });
});
