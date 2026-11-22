import { object, required } from "../config/config-fields.ts";
import { type BuilderCandidate, builderCandidate } from "./selection.ts";

export type { BuilderCandidate } from "./selection.ts";

type BuilderHost = {
	server: string;
	capacity?: number;
	candidates: readonly BuilderCandidate[];
};

export type BuilderProfile = { hosts: readonly BuilderHost[] };

function entries(raw: unknown, where: string): unknown[] {
	if (!Array.isArray(raw) || raw.length === 0) throw Error(`${where}: expected a non-empty array`);
	return raw;
}

function parseHost(raw: unknown, where: string): BuilderHost {
	const host = object(raw, where, ["server", "capacity", "candidates"]);
	const server = required(host, "server", where);
	const { capacity } = host;
	if (capacity !== undefined && (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1))
		throw Error(`${where}: capacity must be a positive integer`);
	const candidates = entries(host.candidates, `${where}.candidates`).map((candidate, index) =>
		builderCandidate(candidate, `${where}.candidates[${index}]`),
	);
	return { server, ...(capacity === undefined ? {} : { capacity }), candidates };
}

export function parseBuilderProfiles(raw: unknown): ReadonlyMap<string, BuilderProfile> {
	const profiles = new Map<string, BuilderProfile>();
	if (raw === null || raw === undefined) return profiles;
	if (typeof raw !== "object" || Array.isArray(raw)) throw Error("builderProfiles: expected an object");
	for (const [name, value] of Object.entries(raw)) {
		if (!name.trim()) throw Error("builderProfiles: profile names must be non-empty");
		const where = `builderProfiles.${name}`;
		const profile = object(value, where, ["hosts"]);
		const hosts = entries(profile.hosts, `${where}.hosts`).map((host, index) =>
			parseHost(host, `${where}.hosts[${index}]`),
		);
		if (new Set(hosts.map((host) => host.server)).size !== hosts.length)
			throw Error(`${where}: each server may appear only once`);
		profiles.set(name, { hosts });
	}
	return profiles;
}

export type BuilderCandidateStatus =
	| "eligible"
	| "provider-unavailable"
	| "project-override"
	| "model-unavailable"
	| "unsupported-option"
	| "quota-exhausted";

export type BuilderHostStatus = "environment-not-linked" | "unavailable" | "project-unavailable" | "load-unavailable";

export type BuilderHostObservation =
	| { ok: false; reason: BuilderHostStatus }
	| { ok: true; active: number; pending: number; candidates: readonly BuilderCandidateStatus[] };

type BuilderRouteReason =
	| { server: string; reason: BuilderHostStatus | "capacity" }
	| { server: string; candidateIndex: number; reason: Exclude<BuilderCandidateStatus, "eligible"> | "unobserved" };

type BuilderRoute = { server: string; candidate: BuilderCandidate; candidateIndex: number; load: number };

type BuilderRouteResult =
	| {
			ok: true;
			server: string;
			candidate: BuilderCandidate;
			candidateIndex: number;
			load: number;
			reasons: BuilderRouteReason[];
	  }
	| { ok: false; reasons: BuilderRouteReason[] };

function firstEligible(
	host: BuilderHost,
	statuses: readonly BuilderCandidateStatus[],
	load: number,
	reasons: BuilderRouteReason[],
): BuilderRoute | undefined {
	const { server } = host;
	for (const [candidateIndex, candidate] of host.candidates.entries()) {
		const status = statuses[candidateIndex];
		if (status === "eligible") return { server, candidate, candidateIndex, load };
		reasons.push({ server, candidateIndex, reason: status ?? "unobserved" });
	}
}

/** Choose the least loaded eligible host. Keep the configured order for ties and for candidates on each host. */
export function selectBuilderRoute(
	profile: BuilderProfile,
	observations: ReadonlyMap<string, BuilderHostObservation>,
): BuilderRouteResult {
	const reasons: BuilderRouteReason[] = [];
	let best: BuilderRoute | undefined;
	for (const host of profile.hosts) {
		const { server } = host;
		const observation = observations.get(server);
		if (!observation?.ok) {
			reasons.push({ server, reason: observation?.reason ?? "unavailable" });
			continue;
		}
		const load = observation.active + observation.pending;
		if (host.capacity !== undefined && load >= host.capacity) {
			reasons.push({ server, reason: "capacity" });
			continue;
		}
		const route = firstEligible(host, observation.candidates, load, reasons);
		if (route && (!best || route.load < best.load)) best = route;
	}
	return best ? { ok: true, ...best, reasons } : { ok: false, reasons };
}
