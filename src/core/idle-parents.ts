/**
 * The `idle-parents` check: every top-level thread that finished its work and has sat idle past a threshold, reported to the
 * Steward in one compact list. A turn-end wake can miss a thread (its closing words matched no rule, or the wake went to a
 * Steward that was busy), and a thread that waits for a word never moves on its own; this check is the net under those misses.
 *
 * It runs on its own timer (`intervalMinutes`, default 15), not on the two-hourly routine sweep (src/core/engine-idle.ts). Selection
 * and ordering are plain code. An optional classifier (`classifier`, off by default; src/core/classifier/) can sort the selection.
 * It is an item source (src/core/source.ts), named `check:idle-parents`. A finding repeats every `repeatHours` (default 2) while
 * the same last message still idles, so a long stall is not silent after the first wake. One digest per pass.
 *
 * Config (`sweep.idleParents`): `enabled`, `intervalMinutes`, `thresholdMinutes`, `maxThreads`, `repeatHours`, `classifier`.
 */
import type { Classified } from "./classifier/classify.ts";
import { CLASSIFIER_DEFAULTS, type ClassifierConfig, parseClassifier } from "./classifier/config.ts";
import type { IdleSelection, IdleThread } from "./idle-select.ts";
import { classifiedText, digestText, idleText } from "./idle-text.ts";
import type { Finding, ItemSource } from "./source.ts";
import type { Store } from "./store.ts";

export { classTag, digestText, EXCERPT_CHARS, excerptOf, idleText } from "./idle-text.ts";

export const IDLE_PARENTS = "idle-parents";
/** The item source name: the same `check:<name>` form every routine check has. */
const IDLE_PARENTS_SOURCE = `check:${IDLE_PARENTS}`;

export type IdleParentsConfig = {
	enabled: boolean;
	intervalMinutes: number;
	thresholdMinutes: number;
	maxThreads: number;
	/** Hours between re-notifies of the same still-open idle finding (default 2). */
	repeatHours: number;
	classifier: ClassifierConfig;
};
export const IDLE_PARENTS_DEFAULTS: IdleParentsConfig = {
	enabled: true,
	intervalMinutes: 15,
	thresholdMinutes: 30,
	maxThreads: 10,
	repeatHours: 2,
	classifier: CLASSIFIER_DEFAULTS,
};

const KEYS = ["enabled", "intervalMinutes", "thresholdMinutes", "maxThreads", "repeatHours", "classifier"];
/** Pure: the `sweep.idleParents` section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseIdleParents(raw: unknown): IdleParentsConfig {
	if (raw === undefined) return { ...IDLE_PARENTS_DEFAULTS, classifier: parseClassifier(undefined) };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("sweep.idleParents: expected an object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!KEYS.includes(k)) throw Error(`sweep.idleParents: unknown key "${k}" (known: ${KEYS.join(", ")})`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error("sweep.idleParents: enabled must be true or false");
	const num = (k: "intervalMinutes" | "thresholdMinutes" | "maxThreads" | "repeatHours", whole: boolean) => {
		const v = o[k];
		if (v === undefined) return IDLE_PARENTS_DEFAULTS[k];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (whole && !Number.isInteger(v)))
			throw Error(`sweep.idleParents: ${k} must be a positive ${whole ? "whole " : ""}number`);
		return v;
	};
	return {
		enabled: o.enabled ?? IDLE_PARENTS_DEFAULTS.enabled,
		intervalMinutes: num("intervalMinutes", false),
		thresholdMinutes: num("thresholdMinutes", false),
		maxThreads: num("maxThreads", true),
		repeatHours: num("repeatHours", false),
		classifier: parseClassifier(o.classifier),
	};
}

/** Pure: the item key of one thread at one last message. */
export const idleKey = (t: Pick<IdleThread, "server" | "threadId" | "lastMessageHash">) =>
	`${t.server}:${t.threadId}:${t.lastMessageHash}`;

/** The item key of the day's settled digest line: one per UTC day. */
export const DIGEST_PREFIX = "settled-digest:";
const digestKey = (day: string) => `${DIGEST_PREFIX}${day}`;

/** What a classifier run gives the findings. */
export type IdleClassification = { mode: "shadow" | "live"; day: string; byKey: ReadonlyMap<string, Classified> };
const RANK: Record<string, number> = { escalate: 0, nudge: 1, unknown: 2 };

/** What the check holds as items, open or resolved. */
export type PriorFinding = { dedupKey: string; text: string; resolved?: boolean };

/** The check's items as `PriorFinding`s. */
export const idlePrior = (store: Pick<Store, "items">): PriorFinding[] =>
	store.items.list({ source: IDLE_PARENTS_SOURCE }).map((i) => ({
		dedupKey: i.dedupKey,
		text: String(i.payload.text ?? i.dedupKey),
		resolved: i.status === "resolved",
	}));

/** Ms between re-notifies from `repeatHours`. */
export const repeatMsOf = (cfg: Pick<IdleParentsConfig, "repeatHours">) => cfg.repeatHours * 3600_000;

/**
 * Pure: the findings for a selection. Cap limits NEW threads only. Already-known keys still observe with the repeat
 * policy so a long stall re-notifies after `repeatHours`. `alreadyReported` keeps a post-resolve same-message return quiet.
 */
export function idleParentFindings(
	sel: IdleSelection,
	cfg: Pick<IdleParentsConfig, "maxThreads" | "repeatHours">,
	prior: readonly PriorFinding[] = [],
	cls?: IdleClassification,
): Finding[] {
	const known = new Set(prior.map((p) => p.dedupKey));
	const resolvedKeys = new Set(prior.filter((p) => p.resolved).map((p) => p.dedupKey));
	const live = cls?.mode === "live" ? cls : undefined;
	const repeatIntervalMs = repeatMsOf(cfg);
	const out = reportedThreads({
		all: sel.threads,
		maxThreads: cfg.maxThreads,
		known,
		resolvedKeys,
		live,
		repeatIntervalMs,
	});
	if (live) {
		const settled = sel.threads.filter((t) => actionOf(t, live) === "settle");
		const key = digestKey(live.day);
		if (settled.length && !known.has(key)) out.push({ dedupKey: key, text: digestText(settled) });
	}
	out.push(...keptOpen(sel.unreadable, prior, out, repeatIntervalMs));
	return out;
}

const actionOf = (t: IdleThread, live: IdleClassification) => live.byKey.get(idleKey(t))?.action ?? "unknown";

type ReportArgs = {
	all: readonly IdleThread[];
	maxThreads: number;
	known: ReadonlySet<string>;
	resolvedKeys: ReadonlySet<string>;
	live: IdleClassification | undefined;
	repeatIntervalMs: number;
};

function reportedThreads({ all, maxThreads, known, resolvedKeys, live, repeatIntervalMs }: ReportArgs): Finding[] {
	const rank = (t: IdleThread, l: IdleClassification) => RANK[actionOf(t, l)] ?? 2;
	const threads = live
		? all
				.filter((t) => actionOf(t, live) in RANK)
				.sort(
					(a, b) =>
						rank(a, live) - rank(b, live) ||
						b.idleMinutes - a.idleMinutes ||
						(`${a.server}\0${a.threadId}` < `${b.server}\0${b.threadId}` ? -1 : 1),
				)
		: all;
	let fresh = 0;
	const out: Finding[] = [];
	for (const t of threads) {
		const dedupKey = idleKey(t);
		const seen = known.has(dedupKey);
		if (!seen && ++fresh > maxThreads) continue;
		const text = live ? classifiedText(t, live.byKey.get(dedupKey)) : idleText(t);
		// alreadyReported only when the prior item had resolved: a still-open finding must keep its repeat policy.
		out.push({
			dedupKey,
			text,
			repeatIntervalMs,
			...(resolvedKeys.has(dedupKey) ? { alreadyReported: true } : {}),
		});
	}
	return out;
}

function keptOpen(
	unreadable: IdleSelection["unreadable"],
	prior: readonly PriorFinding[],
	out: readonly Finding[],
	repeatIntervalMs: number,
): Finding[] {
	const have = new Set(out.map((f) => f.dedupKey));
	const kept: Finding[] = [];
	for (const u of unreadable) {
		const stem = `${u.server}:${u.threadId}:`;
		for (const p of prior)
			if (p.dedupKey.startsWith(stem) && !p.resolved && !have.has(p.dedupKey))
				kept.push({ dedupKey: p.dedupKey, text: p.text, repeatIntervalMs });
	}
	return kept;
}

/** The check as an item source. */
export function idleParentsSource(o: {
	cfg: Pick<IdleParentsConfig, "maxThreads" | "repeatHours">;
	select: () => Promise<IdleSelection>;
	prior: () => PriorFinding[];
	classify?: (threads: readonly IdleThread[]) => Promise<IdleClassification>;
}): ItemSource {
	return {
		name: IDLE_PARENTS_SOURCE,
		run: async () => {
			const sel = await o.select();
			const cls = o.classify ? await o.classify(sel.threads) : undefined;
			return idleParentFindings(sel, o.cfg, o.prior(), cls);
		},
	};
}

/**
 * Pure: after a Steward thread change, open idle findings must notify the new Steward once. Dropping their keys from
 * `prior` (after resolving them) makes the next observation a fresh notify, not an alreadyReported acknowledge.
 */
export function priorAfterStewardChange(
	prior: readonly PriorFinding[],
	resolvedKeys: ReadonlySet<string>,
): PriorFinding[] {
	return prior.filter((p) => !resolvedKeys.has(p.dedupKey));
}

/** Resolves every open idle-parents finding so the next tick can re-notify them to a new Steward. Returns their keys. */
export function resolveOpenIdleParents(store: Pick<Store, "items">, now: number): Set<string> {
	const keys = new Set<string>();
	for (const i of store.items.list({ source: IDLE_PARENTS_SOURCE, status: ["triggered", "acknowledged"] })) {
		if (i.kind !== "finding") continue;
		store.items.resolve(IDLE_PARENTS_SOURCE, i.dedupKey, now, { why: "steward-changed" });
		keys.add(i.dedupKey);
	}
	return keys;
}
