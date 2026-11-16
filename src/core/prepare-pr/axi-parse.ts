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
	/** Milliseconds the agent has been parked awaiting approval, when AXI reports a valid duration. */
	parkedMs: number | null;
};

/** Pure: overview stdout looks like AXI (not garbage that would silently yield zero runs). */
export function isValidAxiOverview(out: string): boolean {
	return /^\s*(bin|daemon|repo|current_branch|description):/m.test(out.trim());
}

/**
 * Pure: parse `parked 25m3s`, `parked 2d10h`, `parked 45s` into milliseconds.
 * The whole remainder after `parked ` must be duration tokens only (no garbage).
 */
export function parseParkedDuration(s: string): number | null {
	const m = s.trim().match(/^parked\s+(.+)$/i);
	const body = m?.[1];
	if (!body) return null;
	if (!/^(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/i.test(body) || !/\d/.test(body)) return null;
	let ms = 0;
	for (const part of body.matchAll(/(\d+)(d|h|m|s)/gi)) {
		const n = Number(part[1]);
		const u = part[2]?.toLowerCase();
		if (!u) continue;
		if (u === "d") ms += n * 86_400_000;
		else if (u === "h") ms += n * 3_600_000;
		else if (u === "m") ms += n * 60_000;
		else ms += n * 1_000;
	}
	return ms;
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
	if (!isValidAxiOverview(out)) throw Error("axi overview: unrecognized output");
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

function parkedMsFromAwaiting(runId: string, runBlock: string): { raw: string | null; parkedMs: number | null } {
	const raw = scalarAfter(runBlock, "awaiting_agent");
	if (raw === null) return { raw: null, parkedMs: null };
	const parkedMs = parseParkedDuration(raw);
	if (parkedMs === null) throw Error(`axi status: run ${runId} awaiting_agent is not a parked duration ("${raw}")`);
	return { raw, parkedMs };
}

function requireAwaitingGate(
	runId: string,
	gate: { step: string | null; status: string | null },
	stepAwaiting: { step: string; status: string } | null,
): { step: string; status: string } {
	const step = gate.step ?? stepAwaiting?.step ?? null;
	const status = gate.status ?? stepAwaiting?.status ?? null;
	if (!step || status !== "awaiting_approval")
		throw Error(`axi status: run ${runId} shows awaiting approval without a complete gate step/status`);
	return { step, status };
}

/**
 * Pure: one run from `axi status --run <id>`.
 * Throws when the output cannot be read as a run, or when awaiting/parked evidence is incomplete (fail closed).
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
	const KNOWN = new Set(["running", "completed", "cancelled", "pending", "handed_off", "awaiting_approval", "failed"]);
	if (!KNOWN.has(status)) throw Error(`axi status: run ${runId} unknown status "${status}"`);
	const head = scalarAfter(runBlock, "head") ?? scalarAfter(runBlock, "head_sha")?.slice(0, 8) ?? null;
	if (!head) throw Error(`axi status: run ${runId} missing head`);

	const awaiting = parkedMsFromAwaiting(runId, runBlock);
	const gate = gateFields(trimmed);
	const stepAwaiting = firstAwaitingStep(trimmed);
	// Top-level status awaiting_approval is itself an awaiting claim: require a complete gate (fail closed).
	const looksAwaiting =
		status === "awaiting_approval" ||
		gate.status === "awaiting_approval" ||
		stepAwaiting !== null ||
		awaiting.raw !== null;
	const resolved = looksAwaiting ? requireAwaitingGate(runId, gate, stepAwaiting) : null;

	return {
		runId,
		branch,
		status,
		head: head.slice(0, 8),
		gateStep: resolved?.step ?? gate.step,
		gateStatus: resolved?.status ?? gate.status,
		parkedMs: awaiting.parkedMs,
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
