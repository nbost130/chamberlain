/**
 * Pure parsers for no-mistakes AXI TOON stdout. Fail closed: missing required fields throw.
 * Contract verified against MemberHero `bun run no-mistakes axi` / `axi status --run <id>` (2026-11-16).
 */

export type AxiParkedRun = {
	runId: string;
	branch: string;
	status: string;
	head: string;
	/** Exact gate step when status is awaiting_approval (e.g. gate.review.one-way-door, lint). */
	gateStep: string | null;
	gateStatus: string | null;
	/** Milliseconds the agent has been parked awaiting approval, when AXI reports it. */
	parkedMs: number | null;
};

/** Pure: parse `parked 25m3s`, `parked 2d10h`, `parked 45s` into milliseconds. */
export function parseParkedDuration(s: string): number | null {
	const m = s.trim().match(/^parked\s+(.+)$/i);
	const body = m?.[1];
	if (!body) return null;
	let ms = 0;
	let matched = false;
	// Units are adjacent (`23m27s`); no word-boundary between digit runs.
	for (const part of body.matchAll(/(\d+)(d|h|m|s)/gi)) {
		const n = Number(part[1]);
		const u = part[2]?.toLowerCase();
		if (!u) continue;
		matched = true;
		if (u === "d") ms += n * 86_400_000;
		else if (u === "h") ms += n * 3_600_000;
		else if (u === "m") ms += n * 60_000;
		else ms += n * 1_000;
	}
	return matched ? ms : null;
}

/** Pure: first quoted or bare value after `key:` on its own line (TOON scalar). */
function scalarAfter(text: string, key: string): string | null {
	const re = new RegExp(`^\\s*${key}:\\s*(.*)$`, "im");
	const m = text.match(re);
	const raw = m?.[1]?.trim();
	if (!raw || raw === "none") return null;
	const q = raw.match(/^"((?:\\.|[^"\\])*)"/);
	const quoted = q?.[1];
	if (quoted !== undefined) return quoted.replace(/\\"/g, '"');
	const bare = raw.split(/\s{2,}/)[0];
	return bare?.replace(/,$/, "").trim() || null;
}

/** Pure: nested block indented under a parent key (e.g. gate: / other_branch_active_run:). */
function blockUnder(text: string, key: string): string | null {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex(
		(l) => new RegExp(`^\\s*${key}:\\s*$`).test(l) || new RegExp(`^\\s*${key}:\\s+\\S`).test(l),
	);
	if (start < 0) return null;
	const startLine = lines[start];
	if (startLine === undefined) return null;
	const parentIndent = (startLine.match(/^(\s*)/)?.[1] ?? "").length;
	const out: string[] = [];
	const same = startLine.slice(parentIndent);
	if (!new RegExp(`^${key}:\\s*$`).test(same)) out.push(same);
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		if (!line.trim()) {
			out.push(line);
			continue;
		}
		const ind = (line.match(/^(\s*)/)?.[1] ?? "").length;
		if (ind <= parentIndent) break;
		out.push(line.slice(parentIndent));
	}
	return out.length ? out.join("\n") : null;
}

/**
 * Pure: active run id(s) from top-level `no-mistakes axi` TOON.
 * Today AXI surfaces at most one `other_branch_active_run`; callers may supplement via state.sqlite.
 */
export function parseAxiOverviewActiveRunIds(out: string): string[] {
	const ids: string[] = [];
	const other = blockUnder(out, "other_branch_active_run");
	if (other) {
		const id = scalarAfter(other, "id");
		if (id) ids.push(id);
	}
	const current = blockUnder(out, "active_run") ?? blockUnder(out, "current_branch_run");
	if (current) {
		const id = scalarAfter(current, "id");
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

function runBlockOf(trimmed: string): string {
	return (
		blockUnder(trimmed, "other_branch_run") ??
		blockUnder(trimmed, "other_branch_active_run") ??
		blockUnder(trimmed, "active_run") ??
		blockUnder(trimmed, "run") ??
		trimmed
	);
}

function requireScalar(block: string, key: string, runId: string): string {
	const v = scalarAfter(block, key);
	if (!v) throw Error(`axi status: run ${runId} missing ${key}`);
	return v;
}

function gateFields(trimmed: string): { step: string | null; status: string | null } {
	const gate = blockUnder(trimmed, "gate");
	const step = gate ? scalarAfter(gate, "step") : null;
	const status = gate ? scalarAfter(gate, "status") : null;
	if (step && status) return { step, status };
	const fromSteps = firstAwaitingStep(trimmed);
	if (!fromSteps) return { step, status };
	return { step: step ?? fromSteps.step, status: status ?? fromSteps.status };
}

/**
 * Pure: one run from `axi status --run <id>` (or the other_branch_run / other_branch_active_run shape).
 * Throws when the output cannot be read as a run (fail closed).
 */
export function parseAxiStatus(out: string, expectedRunId?: string): AxiParkedRun {
	const trimmed = out.trim();
	if (!trimmed) throw Error("axi status: empty output");
	const runBlock = runBlockOf(trimmed);
	const runId = scalarAfter(runBlock, "id");
	if (!runId) throw Error("axi status: missing run id");
	if (expectedRunId && runId !== expectedRunId) throw Error(`axi status: expected run ${expectedRunId}, got ${runId}`);
	const branch = requireScalar(runBlock, "branch", runId);
	const status = requireScalar(runBlock, "status", runId);
	const head = scalarAfter(runBlock, "head") ?? scalarAfter(runBlock, "head_sha")?.slice(0, 8) ?? null;
	if (!head) throw Error(`axi status: run ${runId} missing head`);
	const awaiting = scalarAfter(runBlock, "awaiting_agent");
	const gate = gateFields(trimmed);
	return {
		runId,
		branch,
		status,
		head: head.slice(0, 8),
		gateStep: gate.step,
		gateStatus: gate.status,
		parkedMs: awaiting ? parseParkedDuration(awaiting) : null,
	};
}

/** Pure: first `step,awaiting_approval,...` row under a steps[N]{...}: table. */
function firstAwaitingStep(text: string): { step: string; status: string } | null {
	for (const line of text.split(/\r?\n/)) {
		const m = line.trim().match(/^([A-Za-z0-9._-]+),(awaiting_approval),/);
		const step = m?.[1];
		const status = m?.[2];
		if (step && status) return { step, status };
	}
	return null;
}
