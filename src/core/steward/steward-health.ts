import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { StewardProbe, Transcript } from "../adapter/adapter-inspect.ts";
import type { StewardMeterRead } from "../adapter/steward-meter.ts";
import { effectiveLimits, parseContextGuard } from "../config/context-guard.ts";
import { setting } from "../config/layout.ts";
import { handoffWake } from "../messages.ts";
import type { Store } from "../store/store.ts";
import { HEALTH_CONFIG } from "./steward-health-config.ts";
import { ORDINARY_TURN, type Scan, scanLine } from "./steward-health-scan.ts";

export type Health = {
	schemaVersion?: number;
	at: string;
	verdict: "OK" | "WATCH" | "COMPACT" | "HAND OFF";
	session?: string;
	contextSession?: string;
	thread?: string;
	boundary?: string;
	tokens?: number;
	window?: number;
	source?: string;
	limits?: ReturnType<typeof effectiveLimits>;
	handoffReason?: string;
	peakTokens?: number;
	usageAt?: string;
	contextPending?: boolean;
	readingCoverage?: { self: boolean; threads: boolean };
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
function verdictOf(h: Health, compactAt: number): Health["verdict"] {
	const { tokens, elevated, unknown } = h;
	// The reread limit was set where both kinds of reread are measured. Elsewhere it is shown and watched, and starts nothing: on record, an
	// ordinary Steward passes it within hours, so it would hand off one after another.
	const acts = (e: string) => e !== "context" && (e !== "rereading" || h.readingCoverage?.self !== false);
	if (elevated.some(acts)) return "HAND OFF";
	if (!h.contextPending && tokens !== undefined && tokens > compactAt) return "COMPACT";
	return tokens === undefined || elevated.length || unknown.length ? "WATCH" : "OK";
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
		turn: ORDINARY_TURN,
		recoveryLeft: 0,
	};
	for await (const line of lines) scanLine(scan, line, session, opts);
	const { tokens, slips, selfReads, threadRereads, unknown } = scan;
	if (tokens === undefined) unknown.add("context usage unavailable");
	if (opts.formatPattern && !slips.length) unknown.add("reply hook samples unavailable");
	const elevated = [
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
		verdict: "WATCH",
		report: "",
	};
	return finishHealth(h, parseContextGuard(undefined));
}

function finishHealth(h: Health, policy: ReturnType<typeof parseContextGuard>): Health {
	const limits = effectiveLimits(policy, h.window);
	h.limits = limits;
	if (h.tokens !== undefined && h.tokens >= limits.watchAt) h.elevated.unshift("context");
	h.verdict = verdictOf(h, limits.compactAt);
	h.report = formatHealth(h);
	return h;
}

export function formatHealth(h: Health): string {
	const { watchAt, compactAt } = h.limits ?? effectiveLimits(parseContextGuard(undefined));
	const window = h.window === undefined ? "" : ` of ${h.window}`;
	const self = h.readingCoverage?.self === false ? "not measured" : h.selfReads;
	const threads = h.readingCoverage?.threads === false ? "not measured" : h.threadRereads;
	return [
		`Steward health: ${h.verdict} (${h.at})`,
		`Context: ${h.tokens ?? "unknown"}${window} tokens; watch >=${watchAt}, compact >${compactAt}; peak ${h.peakTokens ?? "unknown"}${h.source ? `; source: ${h.source}` : ""}${h.contextPending ? "; turn in progress" : ""}`,
		...(h.verdict === "COMPACT" ? [`Compaction needed: context is past ${compactAt} tokens.`] : []),
		`Format: ${h.breaks}/${h.replies} recent replies broke; threshold >=${HEALTH_CONFIG.formatBreaks} in last ${HEALTH_CONFIG.replies}`,
		`Rereading: ${self} self-transcript reads (>=${HEALTH_CONFIG.selfReads}); ${threads} repeat thread reads (>=${HEALTH_CONFIG.threadRereads}, ${HEALTH_CONFIG.windowMs / 60000}m window)`,
		`Since compaction: ${h.boundary ?? "session start"}; usage sampled ${h.usageAt ?? "unknown"}`,
		...(h.unknown.length ? [`Unavailable: ${h.unknown.join(", ")}`] : []),
	].join("\n");
}

function unavailableHealth(): Health {
	return {
		at: new Date().toISOString(),
		verdict: "WATCH",
		replies: 0,
		breaks: 0,
		selfReads: 0,
		threadRereads: 0,
		elevated: [],
		unknown: ["Steward transcript unavailable"],
		report: "",
	};
}

/** The adapter owns current context. A transcript, if available, still supplies quality signals and historical peaks. */
export async function guardedHealth(o: {
	find?: () => Promise<Transcript>;
	meter?: StewardMeterRead;
	thread?: string;
	probe?: StewardProbe;
	priorContext?: StewardProbe["lastMeasuredContext"];
	policy: ReturnType<typeof parseContextGuard>;
}): Promise<Health> {
	const h = o.meter
		? await measuredHealth(o.meter, o.find)
		: o.find
			? await liveHealth(o.find).catch(unavailableHealth)
			: unavailableHealth();
	h.thread = o.thread ?? h.thread;
	h.session ??= o.probe?.contextSession;
	h.contextSession = o.probe?.contextSession;
	h.elevated = h.elevated.filter((signal) => signal !== "context");
	applyReading(h, o.probe, o.priorContext);
	return finishHealth(h, o.policy);
}

async function measuredHealth(meter: StewardMeterRead, find?: () => Promise<Transcript>): Promise<Health> {
	const quality = "rows" in meter ? meter.quality : undefined;
	const h = unavailableHealth();
	h.unknown = "unknown" in meter ? [meter.unknown] : quality?.unknown ? [quality.unknown] : [];
	h.readingCoverage = { self: quality?.selfReads !== undefined, threads: quality?.threadRereads !== undefined };
	h.selfReads = quality?.selfReads ?? 0;
	h.threadRereads = quality?.threadRereads ?? 0;
	h.boundary = quality?.boundary;
	if (h.selfReads >= HEALTH_CONFIG.selfReads || h.threadRereads >= HEALTH_CONFIG.threadRereads)
		h.elevated.push("rereading");
	const pattern = formatPatternFromEnv();
	if (find && pattern && h.readingCoverage.self) {
		const format = await liveHealth(find, { formatPattern: pattern }).catch(unavailableHealth);
		h.replies = format.replies;
		h.breaks = format.breaks;
		h.peakTokens = format.peakTokens;
		if (format.elevated.includes("format")) h.elevated.push("format");
		if (!format.replies) h.unknown.push("reply hook samples unavailable");
	}
	return h;
}

function applyReading(h: Health, probe: StewardProbe | undefined, priorContext?: StewardProbe["lastMeasuredContext"]) {
	h.contextPending = probe?.contextPending;
	const previous = [probe?.lastMeasuredContext, priorContext].sort((a, b) =>
		(b?.at ?? "").localeCompare(a?.at ?? ""),
	)[0];
	const reading =
		h.contextPending && probe?.context && "unknown" in probe.context ? (previous ?? probe.context) : probe?.context;
	if (reading || probe?.contextTokens !== undefined) {
		h.unknown = h.unknown.filter((signal) => signal !== "context usage unavailable");
		h.tokens = reading ? undefined : probe?.contextTokens;
		h.usageAt = undefined;
	}
	if (reading && "tokens" in reading) {
		h.tokens = reading.tokens;
		h.usageAt = reading.at;
		h.window = reading.window;
		h.source = reading.source;
	}
	if (h.tokens === undefined && !h.contextPending && !h.unknown.includes("context usage unavailable"))
		h.unknown.push(reading && "unknown" in reading ? reading.unknown : "context usage unavailable");
}
/**
 * Measures the optional native transcript when that is the adapter's only health source or when a format hook is enabled.
 */
async function liveHealth(
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
