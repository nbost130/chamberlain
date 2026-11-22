import { expect, test } from "bun:test";
import { parseConfigDoc } from "../config/layout-schema.ts";
import { type BuilderHostObservation, parseBuilderProfiles, selectBuilderRoute } from "./builder-routing.ts";
import { parseModels } from "./selection.ts";

const main = {
	server: "main",
	capacity: 3,
	candidates: [
		{ instanceId: "subscription", model: "primary", options: { effort: "high" } },
		{ instanceId: "subscription", model: "secondary" },
	],
};
const laptop = { server: "laptop", candidates: [{ instanceId: "local", model: "alternate" }] };
const builderProfiles = { builders: { hosts: [main, laptop] } };
const profile = parseBuilderProfiles(builderProfiles).get("builders")!;

test("only worker and butler can reference a defined builder profile", () => {
	const selection = { profile: "builders" };
	const models = { worker: selection, butler: selection };
	expect(parseConfigDoc({ builderProfiles, models, servers: [{ name: "main" }, { name: "laptop" }] }).models).toEqual(
		models,
	);
	expect(parseModels(models)).toEqual(models);
	expect(() => parseModels({ steward: selection })).toThrow("builder profiles require worker or butler");
	expect(() => parseModels({ worker: { ...selection, adapter: "t3" } })).toThrow("unknown key");
	expect(() => parseConfigDoc({ models })).toThrow("profile must name a configured builder profile");
	expect(() => parseConfigDoc({ builderProfiles, models, servers: [{ name: "main" }] })).toThrow(
		"server must name a configured server",
	);
});

test("profile hosts have an explicit candidate order and positive capacity when specified", () => {
	expect(() => parseBuilderProfiles({ builders: { hosts: [main, main] } })).toThrow("only once");
	expect(() => parseBuilderProfiles({ builders: { hosts: [{ ...main, candidates: [] }] } })).toThrow("non-empty array");
	expect(() => parseBuilderProfiles({ builders: { hosts: [{ ...main, capacity: 0 }] } })).toThrow(
		"capacity must be a positive integer",
	);
});

test("selection uses total load, host order for ties, and the first eligible candidate", () => {
	const observations = new Map<string, BuilderHostObservation>([
		["laptop", { ok: true, active: 1, pending: 0, candidates: ["eligible"] }],
		["main", { ok: true, active: 0, pending: 2, candidates: ["quota-exhausted", "eligible"] }],
	]);
	expect(selectBuilderRoute(profile, observations)).toMatchObject({ ok: true, server: "laptop", load: 1 });

	observations.set("main", { ok: true, active: 0, pending: 1, candidates: ["quota-exhausted", "eligible"] });
	expect(selectBuilderRoute(profile, observations)).toEqual({
		ok: true,
		server: "main",
		candidate: { instanceId: "subscription", model: "secondary", options: {} },
		candidateIndex: 1,
		load: 1,
		reasons: [{ server: "main", candidateIndex: 0, reason: "quota-exhausted" }],
	});

	observations.set("main", { ok: true, active: 0, pending: 1, candidates: ["eligible", "eligible"] });
	expect(selectBuilderRoute(profile, observations)).toMatchObject({ ok: true, server: "main", candidateIndex: 0 });
});

test("the route reports saturated hosts, failed probes and unobserved candidates", () => {
	const observations = new Map<string, BuilderHostObservation>([
		["main", { ok: true, active: 1, pending: 2, candidates: ["eligible", "eligible"] }],
		["laptop", { ok: false, reason: "project-unavailable" }],
	]);
	expect(selectBuilderRoute(profile, observations)).toEqual({
		ok: false,
		reasons: [
			{ server: "main", reason: "capacity" },
			{ server: "laptop", reason: "project-unavailable" },
		],
	});

	observations.set("main", { ok: true, active: 0, pending: 0, candidates: ["unsupported-option"] });
	observations.delete("laptop");
	expect(selectBuilderRoute(profile, observations)).toEqual({
		ok: false,
		reasons: [
			{ server: "main", candidateIndex: 0, reason: "unsupported-option" },
			{ server: "main", candidateIndex: 1, reason: "unobserved" },
			{ server: "laptop", reason: "unavailable" },
		],
	});
});
