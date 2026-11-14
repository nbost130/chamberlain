import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Transcript } from "./adapter.ts";
import { handoffWake } from "./messages.ts";
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
	threadReadKey?: (tool: string, input: Record<string, any>) => string | undefined;
	/**
	 * A regular expression for a prompt hook that grades each reply. Its first capture group is "broke..." for a reply
	 * that slipped, anything else for a clean one. Without it the format signal is off and nothing is reported as unknown.
	 */
	formatPattern?: RegExp;
};

/** The format pattern from CHAMBERLAIN_HEALTH_FORMAT_PATTERN (a regular expression), if it is set and valid. */
export function formatPatternFromEnv(): RegExp | undefined {
	const raw = process.env.CHAMBERLAIN_HEALTH_FORMAT_PATTERN;
	if (!raw) return undefined;
	try {
		return new RegExp(raw);
	} catch {
		return undefined;
	}
}

/** Stream only the canonical transcript rows, not API request snapshots or sidechains. */
export async function measure(
	lines: AsyncIterable<string> | Iterable<string>,
	session: string,
	now = Date.now(),
	opts: MeasureOptions = {},
): Promise<Health> {
	let tokens: number | undefined,
		peakTokens: number | undefined,
		usageAt: string | undefined,
		boundary: string | undefined;
	let slips: boolean[] = [],
		selfReads = 0,
		threadRereads = 0;
	const tools = new Set<string>(),
		hooks = new Set<string>(),
		threads = new Map<string, number>();
	const unknown = new Set<string>();
	for await (const line of lines) {
		if (!line.trim()) continue;
		let r: any;
		try {
			r = JSON.parse(line);
		} catch {
			unknown.add("malformed transcript row");
			continue;
		}
		if (r.isSidechain) continue;
		if (r.type === "system" && r.subtype === "compact_boundary") {
			tokens = peakTokens = undefined;
			usageAt = undefined;
			boundary = r.timestamp;
			slips = [];
			selfReads = threadRereads = 0;
			tools.clear();
			hooks.clear();
			threads.clear();
			unknown.clear();
			continue;
		}
		if (
			r.type === "attachment" &&
			r.attachment?.type === "hook_additional_context" &&
			r.attachment?.hookEvent === "UserPromptSubmit"
		) {
			const text = typeof r.rendered === "string" ? r.rendered : JSON.stringify(r.attachment ?? {});
			const hit = opts.formatPattern ? text.match(opts.formatPattern) : null;
			if (hit && !hooks.has(r.uuid)) {
				hooks.add(r.uuid);
				slips.push(String(hit[1] ?? "").startsWith("broke"));
				slips = slips.slice(-HEALTH_CONFIG.replies);
			}
		}
		if (r.type !== "assistant") continue;
		const u = r.message?.usage;
		// Latest assistant usage is a snapshot, never a sum across responses or streaming blocks.
		if (u) {
			const values = [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
			tokens = values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
				? values.reduce((a, b) => a + b, 0)
				: undefined;
			if (tokens !== undefined) peakTokens = Math.max(peakTokens ?? 0, tokens);
			usageAt = r.timestamp;
		}
		for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
			if (c.type !== "tool_use" || !c.id || tools.has(c.id)) continue;
			tools.add(c.id);
			const input = c.input ?? {},
				name = String(c.name);
			if (
				(name === "Read" && String(input.file_path ?? "").endsWith(`/${session}.jsonl`)) ||
				(name === "Bash" &&
					/\b(cat|tail|head|sed|rg|grep|readFileSync|readFile)\b/.test(input.command ?? "") &&
					String(input.command).includes(`${session}.jsonl`))
			)
				selfReads++;
			const key = opts.threadReadKey?.(name, input);
			if (key) {
				const time = Date.parse(r.timestamp),
					prior = threads.get(key);
				if (!Number.isFinite(time)) {
					unknown.add("read timestamp missing");
					continue;
				}
				if (prior !== undefined && time >= prior && time - prior <= HEALTH_CONFIG.windowMs) threadRereads++;
				threads.set(key, time);
			}
		}
	}
	if (tokens === undefined) unknown.add("context usage unavailable");
	if (opts.formatPattern && !slips.length) unknown.add("reply hook samples unavailable");
	const elevated = [
		tokens !== undefined && tokens >= HEALTH_CONFIG.context ? "context" : "",
		slips.filter(Boolean).length >= HEALTH_CONFIG.formatBreaks ? "format" : "",
		selfReads >= HEALTH_CONFIG.selfReads || threadRereads >= HEALTH_CONFIG.threadRereads ? "rereading" : "",
	].filter(Boolean);
	// Context size alone calls for compaction, never a hand-off; only degraded quality signals do.
	const degraded = elevated.some((e) => e !== "context");
	const verdict = degraded
		? "HAND OFF"
		: tokens !== undefined && tokens > HEALTH_CONFIG.compactContext
			? "COMPACT"
			: elevated.length || unknown.size
				? "WATCH"
				: "OK";
	const h: Health = {
		at: new Date(now).toISOString(),
		session,
		boundary,
		tokens,
		peakTokens,
		usageAt,
		replies: slips.length,
		breaks: slips.filter(Boolean).length,
		selfReads,
		threadRereads,
		elevated,
		unknown: [...unknown],
		verdict,
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

/**
 * One daemon owns this tick. A HAND OFF verdict starts the hand-off itself when the adapter can say how (`handoff`: it queues the hand-off
 * wake in the outbox, so the relay's attempts, pauses and dead-letter rules apply and nothing is sent from here). Without that, or without
 * a session to name, it asks the operator through the decision queue (`ask`), as before; its queue tag survives a crash between ask.ts and
 * our result write. Either way a session is handled once: the outbox row (or the queue item) is the record, so a restart or a compaction
 * never repeats it.
 */
export function healthTicker(deps: {
	store: Store;
	collect: () => Promise<Health>;
	now?: () => number;
	/** Queues the hand-off wake for this session, under `handoffDeliveryId(session)`. Absent (the adapter cannot say how a Steward hands off): the operator is asked instead. */
	handoff?: (h: Health, session: string) => void;
	ask?: (raw: object) => Promise<void>;
	/** The server name shown on the hand-off question: the one the Steward runs on. */
	server?: () => string;
}) {
	let busy = false;
	return async () => {
		const now = (deps.now ?? Date.now)(),
			prior = readHealth(deps.store);
		if (busy || (prior && now - Date.parse(prior.at) < HEALTH_CONFIG.intervalMs)) return;
		busy = true;
		try {
			let h: Health;
			try {
				h = await deps.collect();
			} catch {
				h = {
					at: new Date(now).toISOString(),
					verdict: "WATCH",
					replies: 0,
					breaks: 0,
					selfReads: 0,
					threadRereads: 0,
					elevated: [],
					unknown: ["Steward transcript unavailable"],
					report: "",
				};
				h.report = formatHealth(h);
			}
			deps.store.state.set(HEALTH_KEY, h);
			if (h.verdict !== "HAND OFF" || !h.session) return;
			if (deps.handoff) {
				deps.handoff(h, h.session);
				return;
			}
			if (!deps.ask) return;
			const tag = `steward-health:${h.session}`;
			if (!deps.store.items.list({ source: "queue" }).some((i) => i.payload.tag === tag))
				await deps.ask({
					kind: "only-you",
					title: "Steward quality has slipped and needs a handoff",
					context:
						h.report +
						"\nQuality signals (format slips or repeat reads) are past their limits, which compaction does not fix. Recommend /steward-handoff; nothing starts automatically.",
					options: [{ label: "Hand off now" }, { label: "Not yet" }],
					recommended: 0,
					thread: "Steward",
					server: deps.server?.() ?? "main",
					threadId: h.thread,
					tag,
				});
		} finally {
			busy = false;
		}
	};
}
