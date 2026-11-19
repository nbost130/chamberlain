/**
 * What the whole fleet spent on Claude, read from the LifeOS database (`otel_api_requests`, one row per API request, from every host), plus
 * the two slices Chamberlain started itself that the Steward's own transcript does not hold: eval and butler threads (by the project their
 * session ran in) and the overhead investigator (by its thread title).
 *
 * Read-only by construction: the only door is `lifeos-axi query --sql <SELECT>`, whose role can read and cannot write. The statement is built here
 * from numbers and from names config.ts has already restricted to plain characters, so nothing a config says can change its shape.
 *
 * It fails closed: a command that is missing, slow or answers with something unexpected rejects, and the report shows the spend share as
 * unavailable. It never turns a failed read into a zero.
 */
import { execFile } from "node:child_process";
import type { OverheadConfig } from "./config.ts";

export type FleetSpend = {
	totalUsd: number;
	byHost: Record<string, number>;
	/** Hosts in config that have no row in the window: the total is then short by what they spent. */
	missingHosts: string[];
	spawnedUsd: number;
	investigatorUsd: number;
};

/** Runs the query command with its arguments and returns what it printed. A test gives its own. */
export type RunQuery = (command: string, args: string[]) => Promise<string>;

const runQuery: RunQuery = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
			if (err)
				return reject(
					Error(`LifeOS query failed: ${(stderr || err.message).toString().replace(/\s+/g, " ").slice(0, 160)}`),
				);
			resolve(stdout.toString());
		});
	});

const quoted = (names: readonly string[]) => names.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");

/** Pure: the one SELECT, for [from, to) in epoch milliseconds. */
export function fleetSql(cfg: OverheadConfig, from: number, to: number): string {
	const span = `o.occurred_at >= to_timestamp(${Math.floor(from / 1000)}) AND o.occurred_at < to_timestamp(${Math.floor(to / 1000)})`;
	const sum = "coalesce(round(sum(o.cost_usd_micros)), 0)::bigint";
	const join = "FROM otel_api_requests o JOIN sessions s ON s.id = o.session_id";
	const projects = cfg.fleet.spawnedProjects;
	return [
		`SELECT 'fleet' AS k, o.host AS name, ${sum} AS micros FROM otel_api_requests o WHERE ${span} GROUP BY o.host`,
		...(projects.length
			? [
					`SELECT 'spawned', s.project, ${sum} ${join} WHERE ${span} AND s.project IN (${quoted(projects)}) GROUP BY s.project`,
				]
			: []),
		`SELECT 'investigator', 'investigator', ${sum} ${join} WHERE ${span} AND s.title LIKE '${cfg.investigator.title.replace(/'/g, "''")}%'`,
	].join(" UNION ALL ");
}

/** Pure: the rows of the query's CSV answer, from the lines of the form `fleet,mac,1234`. The tool's own header and help lines are ignored. */
export function parseFleet(output: string, cfg: OverheadConfig): FleetSpend {
	const byHost: Record<string, number> = {};
	let spawned = 0;
	let investigator = 0;
	for (const line of output.split("\n")) {
		const m = /^(fleet|spawned|investigator),([^,]*),(-?\d+)$/.exec(line.trim());
		if (!m) continue;
		const usd = Number(m[3]) / 1_000_000;
		if (m[1] === "fleet") byHost[m[2] as string] = usd;
		else if (m[1] === "spawned") spawned += usd;
		else investigator += usd;
	}
	if (!Object.keys(byHost).length) throw Error("the LifeOS query returned no fleet rows");
	const totalUsd = Object.values(byHost).reduce((a, b) => a + b, 0);
	return {
		totalUsd,
		byHost,
		missingHosts: cfg.fleet.hosts.filter((h) => byHost[h] === undefined),
		spawnedUsd: spawned,
		investigatorUsd: investigator,
	};
}

/** The fleet's spend over [from, to). Rejects when the LifeOS database cannot be read: the caller reports "unavailable". */
export async function fleetSpend(
	cfg: OverheadConfig,
	from: number,
	to: number,
	run: RunQuery = runQuery,
): Promise<FleetSpend> {
	return parseFleet(await run(cfg.fleet.command, ["query", "--sql", fleetSql(cfg, from, to), "--limit", "50"]), cfg);
}
