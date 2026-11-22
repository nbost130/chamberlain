/** Steward-side launch planning. Adapters own discovery and the launch arguments they return. */
import { loadServers, makeAdapter } from "./adapters/index.ts";
import type { BuilderProbeResult } from "./core/adapter/adapter.ts";
import { thread } from "./core/config/layout.ts";
import { THREADS } from "./core/config/layout-schema.ts";
import type { BuilderReservation, BuilderReservations } from "./core/llm/builder-reservations.ts";
import { type BuilderHostObservation, type BuilderProfile, selectBuilderRoute } from "./core/llm/builder-routing.ts";
import type { ModelSelections } from "./core/llm/selection.ts";

type Probe = BuilderProbeResult & { adapter: string };
export type BuilderPlan = { server: string; adapter: string; launch: Readonly<Record<string, unknown>> };

const scopeOf = (probe: Extract<Probe, { ok: true }>) => JSON.stringify([probe.adapter, probe.environmentId]);

async function probeHosts({ conf, profile, project, models, role, t3Environments }: BuilderRequest) {
	const servers = loadServers(conf);
	return new Map(
		await Promise.all(
			profile.hosts.map(async (host) => {
				const server = servers.find((entry) => entry.name === host.server);
				const unavailable: Probe = { ok: false, reason: "unavailable", adapter: server?.adapter ?? "" };
				if (!server) return [host.server, unavailable] as const;
				try {
					const adapter = makeAdapter(server, { conf });
					const residentThreadIds = THREADS.flatMap((role) => {
						const pinned = models[role];
						const id = pinned?.adapter === "t3" && pinned.server === host.server && thread(conf, role);
						return id ? [id] : [];
					});
					const probe = await adapter.probeBuilder?.({
						project,
						candidates: host.candidates,
						residentThreadIds,
						workspaceStrategy: role === "worker" ? "worktree" : "root",
					});
					if (probe?.ok && server.adapter === "t3" && t3Environments && !t3Environments.includes(probe.environmentId))
						return [host.server, { ...unavailable, reason: "environment-not-linked" } as const] as const;
					return [host.server, probe ? { ...probe, adapter: server.adapter } : unavailable] as const;
				} catch {
					return [host.server, unavailable] as const;
				}
			}),
		),
	);
}

function decide(
	profile: BuilderProfile,
	probes: ReadonlyMap<string, Probe>,
	held: readonly BuilderReservation<BuilderPlan>[],
) {
	const observations = new Map<string, BuilderHostObservation>();
	for (const [server, probe] of probes) {
		observations.set(
			server,
			probe.ok
				? {
						ok: true,
						active: probe.activeThreadIds.length,
						pending: held.filter((row) => row.scope === scopeOf(probe)).length,
						candidates: probe.candidates,
					}
				: probe,
		);
	}
	const route = selectBuilderRoute(profile, observations);
	const explanation = { hosts: Object.fromEntries(observations), reasons: route.reasons };
	if (!route.ok) throw Error(`no eligible builder route: ${JSON.stringify(explanation)}`);
	const probe = probes.get(route.server);
	const launch = probe?.ok && probe.launches[route.candidateIndex];
	if (!probe?.ok || !launch) throw Error("adapter did not supply launch arguments for the eligible candidate");
	return { scope: scopeOf(probe), plan: { server: route.server, adapter: probe.adapter, launch }, explanation };
}

export function reservedPlan(
	reservation: BuilderReservation<BuilderPlan>,
	acquired: boolean,
	t3Environments?: readonly string[],
) {
	const { adapter, launch } = reservation.plan;
	if (
		reservation.status === "pending" &&
		adapter === "t3" &&
		t3Environments &&
		(typeof launch.environmentId !== "string" || !t3Environments.includes(launch.environmentId))
	)
		throw Error("reserved environment is outside the launch session’s eligible environments; reservation retained");
	const { requestId, attemptId, status, threadId } = reservation;
	return { ...reservation.plan, reservation: { requestId, attemptId, status, acquired, threadId } };
}

type BuilderRequest = {
	conf: string;
	role: "worker" | "butler";
	t3Environments?: readonly string[];
	profile: BuilderProfile;
	models: ModelSelections;
	project: string;
	reservations: BuilderReservations<BuilderPlan>;
	binding: string;
	requestId?: string;
};
export async function planBuilder(request: BuilderRequest) {
	const { profile, reservations, binding, requestId } = request;
	const startedAt = Date.now();
	const probes = await probeHosts(request);
	const observed = new Map<string, ReadonlySet<string>>();
	for (const probe of probes.values()) {
		if (probe.ok) observed.set(scopeOf(probe), new Set(probe.observedThreadIds));
	}
	const choose = (rows: readonly BuilderReservation<BuilderPlan>[]) => decide(profile, probes, rows);
	if (!requestId) {
		const result = reservations.preview(choose, { observed, snapshotStartedAt: startedAt });
		return { ...result.plan, explanation: result.explanation };
	}
	const { reservation, acquired } = reservations.reserve(requestId, binding, choose, {
		observed,
		snapshotStartedAt: startedAt,
	});
	return reservedPlan(reservation, acquired, request.t3Environments);
}
