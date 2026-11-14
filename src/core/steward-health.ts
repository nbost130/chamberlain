import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Transcript } from "./adapter-inspect.ts";
import { setting } from "./layout.ts";
import { handoffWake } from "./messages.ts";
import { type Scan, scanLine } from "./steward-health-scan.ts";
import type { Store } from "./store.ts";

export const HEALTH_CONFIG = {
	context: 200_000, // Watch threshold, well below the compaction threshold.
	compactContext: 350_000, // The Steward is one permanent thread that compacts past 350k; the daemon's compact threshold defaults to this too.
	replies: 20, // Recent behavior, rather than lifetime mistakes.
	formatBreaks: 3, // Three slips in the recent window filters isolated mistakes.
	selfReads: 3, // Repeated reconstruction is a warning; one lookup is ordinary work.
	threadRereads: 4, // Several repeated lookups before treating normal checking as wear.
	windowMs: 10 * 60_000, // Same-thread reads within ten minutes are a repeat.
	intervalMs: 60 * 60_000, // Hourly, as requested.
};
export type Health = {
	schemaVersion?: number;
	at: string;
	verdict: "OK" | "WATCH" | "COMPACT" | "HAND OFF";
	session?: string;
	thread?: string;
	boundary?: string;
	tokens?: number;
	peakTokens?: number;
	usageAt?: string;
	replies: number;
	breaks: number;
	selfReads: number;
	threadRereads: number;
	elevated: string[];
	unknown: string[];
	report: string;
};

export type MeasureOptions = {
	/**
	 * Names a tool call that reads another thread, by the thread it reads, so reading one repeatedly counts as rereading.
	 * The adapter knows its backend's tools (`Transcript.threadReadKey`); without one the rereading signal counts nothing.
	 */
	threadReadKey?: (tool: string, input: Record<string, unknown>) => string | undefined;
	/**
	 * A regular expression for a prompt hook that grades each reply. Its first capture group is "broke..." for a reply
	 * that slipped, anything else for a clean one. Without it the format signal is off and nothing is reported as unknown.
	 */
	formatPattern?: RegExp;
};

/** The format pattern from `healthFormatPattern` (CHAMBERLAIN_HEALTH_FORMAT_PATTERN, or config.json; a regular expression), if it is set and valid. */
function formatPatternFromEnv(): RegExp | undefined {
	const raw = setting("healthFormatPattern");
	if (!raw) return undefined;
	try {
		return new RegExp(raw);
	} catch {
		return undefined;
	}
}

/** Context size alone calls for compaction, never a hand-off; only degraded quality signals do. */
function verdictOf(tokens: number | undefined, elevated: string[], unknownCount: number): Health["verdict"] {
	if (elevated.some((e) => e !== "context")) return "HAND OFF";
	if (tokens !== undefined && tokens > HEALTH_CONFIG.compactContext) return "COMPACT";
	return elevated.length || unknownCount ? "WATCH" : "OK";
}

/** Stream only the canonical transcript rows, not API request snapshots or sidechains. */
export async function measure(
	lines: AsyncIterable<string> | Iterable<string>,
	session: string,
	now = Date.now(),
	opts: MeasureOptions = {},
): Promise<Health> {
	const scan: Scan = {
		slips: [],
		selfReads: 0,
		threadRereads: 0,
		tools: new Set(),
		hooks: new Set(),
		threads: new Map(),
		unknown: new Set(),
	};
	for await (const line of lines) scanLine(scan, line, session, opts);
	const { tokens, slips, selfReads, threadRereads, unknown } = scan;
	if (tokens === undefined) unknown.add("context usage unavailable");
	if (opts.formatPattern && !slips.length) unknown.add("reply hook samples unavailable");
	const elevated = [
		tokens !== undefined && tokens >= HEALTH_CONFIG.context ? "context" : "",
		slips.filter(Boolean).length >= HEALTH_CONFIG.formatBreaks ? "format" : "",
		selfReads >= HEALTH_CONFIG.selfReads || threadRereads >= HEALTH_CONFIG.threadRereads ? "rereading" : "",
	].filter(Boolean);
	const h: Health = {
		at: new Date(now).toISOString(),
		session,
		boundary: scan.boundary,
		tokens,
		peakTokens: scan.peakTokens,
		usageAt: scan.usageAt,
		replies: slips.length,
		breaks: slips.filter(Boolean).length,
		selfReads,
		threadRereads,
		elevated,
		unknown: [...unknown],
		verdict: verdictOf(tokens, elevated, unknown.size),
		report: "",
	};
	h.report = formatHealth(h);
	return h;
}
export function formatHealth(h: Health): string {
	return [
		`Steward health: ${h.verdict} (${h.at})`,
		`Context: ${h.tokens ?? "unknown"} tokens; watch >=${HEALTH_CONFIG.context}, compact >${HEALTH_CONFIG.compactContext}; peak ${h.peakTokens ?? "unknown"}`,
		...(h.verdict === "COMPACT"
			? [
					`Compaction needed: context is past ${HEALTH_CONFIG.compactContext} tokens and quality signals are healthy; no hand-off needed.`,
				]
			: []),
		`Format: ${h.breaks}/${h.replies} recent replies broke; threshold >=${HEALTH_CONFIG.formatBreaks} in last ${HEALTH_CONFIG.replies}`,
		`Rereading: ${h.selfReads} self-transcript reads (>=${HEALTH_CONFIG.selfReads}); ${h.threadRereads} repeat thread reads (>=${HEALTH_CONFIG.threadRereads}, ${HEALTH_CONFIG.windowMs / 60000}m window)`,
		`Since compaction: ${h.boundary ?? "session start"}; usage sampled ${h.usageAt ?? "unknown"}`,
		...(h.unknown.length ? [`Unavailable: ${h.unknown.join(", ")}`] : []),
	].join("\n");
}
/**
 * Measures the Steward's own Claude Code transcript, wherever the adapter says it is (`Adapter.transcriptPath`).
 * This is the one health signal tied to a provider: another provider's Steward has no such transcript, and an adapter
 * that cannot find one reports it as unavailable, never as OK.
 */
export async function liveHealth(
	find: () => Promise<Transcript>,
	opts: MeasureOptions = { formatPattern: formatPatternFromEnv() },
): Promise<Health> {
	const t = await find();
	opts = { ...opts, threadReadKey: opts.threadReadKey ?? t.threadReadKey };
	const stream = createReadStream(t.path, "utf8");
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		return { ...(await measure(lines, t.session, Date.now(), opts)), thread: t.thread };
	} finally {
		lines.close();
		stream.destroy();
	}
}
export const HEALTH_KEY = "steward-health";
/** The latest verdict the daemon stored (state key `steward-health`). */
export function readHealth(store: Store): Health | undefined {
	try {
		return store.state.get<Health>(HEALTH_KEY);
	} catch {
		return undefined;
	}
}
/** The delivery id of a session's hand-off wake. The outbox knows an id for good (pending, delivered or dead-lettered), so one session is told once. */
export const handoffDeliveryId = (session: string) => `steward-handoff:${session}`;
/** The wake that starts the hand-off itself. `instruction` is the adapter's words for how the Steward starts one on its backend (`Adapter.handoffInstruction`). */
export const handoffWakeMessage = (h: Health, instruction: string) => handoffWake(instruction, h.report);
