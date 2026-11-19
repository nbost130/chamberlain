/**
 * What the whole fleet spent on Claude, read from the LifeOS database (`otel_api_requests`, one row per API request, from every host). The
 * threads Chamberlain launched itself (butlers, investigators) are NOT found here: they are named by Chamberlain's own launch records and read by
 * thread id (managed-spend.ts), never by a project or a title, which any other session could share.
 *
 * EXPERIMENTS ARE LEFT OUT. A session whose project is in `excludeProjects`, or that carries a label in `excludeLabels`, is not in the fleet total;
 * its spend is returned apart (`excludedUsd`) so the report can show what was left out. A request with no session row cannot be told to be an
 * experiment, so it stays in the total.
 *
 * Read-only by construction: the only door is `lifeos-axi query --sql <SELECT>`, whose role can read and cannot write. The statement is built here
 * from numbers and from names config.ts has already restricted to plain characters, so nothing a config says can change its shape.
 *
 * It fails closed: a command that is missing, slow or answers with something unexpected rejects, and the report shows the spend share as
 * unavailable. It never turns a failed read into a zero.
 */
import { execFile } from "node:child_process";
import type { OverheadConfig } from "./config.ts";
import { excludedSql, spanSql } from "./sql.ts";

export type FleetSpend = {
	totalUsd: number;
	byHost: Record<string, number>;
	/** Hosts in config that have no row in the window: the total is then short by what they spent. */
	missingHosts: string[];
	/** What the excluded sessions (experiments) spent in the window: not in the total. Zero when nothing is excluded. */
	excludedUsd: number;
};

/** Runs the query command with its arguments and returns what it printed. A test gives its own. */
export type RunQuery = (command: string, args: string[]) => Promise<string>;

export const runQuery: RunQuery = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
			if (err)
				return reject(
					Error(`LifeOS query failed: ${(stderr || err.message).toString().replace(/\s+/g, " ").slice(0, 160)}`),
				);
			resolve(stdout.toString());
		});
	});

/** Pure: the one SELECT, for [from, to) in epoch milliseconds. */
export function fleetSql(cfg: OverheadConfig, from: number, to: number): string {
	const span = spanSql(from, to);
	const sum = "coalesce(round(sum(o.cost_usd_micros)), 0)::bigint";
	const excluded = excludedSql(cfg);
	const join = "FROM otel_api_requests o LEFT JOIN sessions s ON s.id = o.session_id";
	if (!excluded)
		return `SELECT 'fleet' AS k, o.host AS name, ${sum} AS micros FROM otel_api_requests o WHERE ${span} GROUP BY o.host`;
	return [
		`SELECT 'fleet' AS k, o.host AS name, ${sum} AS micros ${join} WHERE ${span} AND NOT (${excluded}) GROUP BY o.host`,
		`SELECT 'excluded', 'excluded', ${sum} ${join} WHERE ${span} AND (${excluded})`,
	].join(" UNION ALL ");
}

/** Pure: the rows of the query's CSV answer, from the lines of the form `fleet,mac,1234`. The tool's own header and help lines are ignored. */
export function parseFleet(output: string, cfg: OverheadConfig): FleetSpend {
	const byHost: Record<string, number> = {};
	let excludedUsd = 0;
	for (const line of output.split("\n")) {
		const m = /^(fleet|excluded),([^,]*),(-?\d+)$/.exec(line.trim());
		if (!m) continue;
		const usd = Number(m[3]) / 1_000_000;
		if (m[1] === "fleet") byHost[m[2] as string] = usd;
		else excludedUsd += usd;
	}
	if (!Object.keys(byHost).length) throw Error("the LifeOS query returned no fleet rows");
	const totalUsd = Object.values(byHost).reduce((a, b) => a + b, 0);
	return { totalUsd, byHost, missingHosts: cfg.fleet.hosts.filter((h) => byHost[h] === undefined), excludedUsd };
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
