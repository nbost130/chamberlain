/** The Alert Desk's settings: its constants, the config file and where its inbox is. */
import { cfg } from "./layout.ts";

export const ALERT_DESK = "alert-desk";
export const DESK_RECEIVER = "desk";
export const DESK_KIND = "alert_desk";
export const DAY_MS = 24 * 3600_000;

const SEVERITIES = ["critical", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type DeskEvent = { source: string; family: string; title: string; body: string; ts: string; severity: Severity };

export type DeskConfig = {
	enabled: boolean;
	windowMs: number;
	repeatMs: number;
	/** Alert wakes per rolling 24 h. 0 = no cap. */
	dailyCap: number;
	/** Local hour (in `timezone`) from which the day's morning wake may go. */
	morningHour: number;
	timezone: string;
	/** An inbox event older than this is stale when read, and is not woken about. */
	maxAgeMs: number;
	/** The inbox is renamed away once it is fully read and larger than this. */
	rotateBytes: number;
	/**
	 * Where the desk starts reading when no cursor is stored (its first run, or its first run after an import that does not carry the old
	 * system's desk state over): "end" (the default) skips what the inbox already holds, so old events never wake anyone; "beginning" reads
	 * the whole inbox (events older than `maxAgeMs` are still not woken about). The choice is logged once (`alert-desk-start`).
	 */
	startAt: "end" | "beginning";
};
export const DEFAULTS: DeskConfig = {
	enabled: true,
	windowMs: 15 * 60_000,
	repeatMs: DAY_MS,
	dailyCap: 30,
	morningHour: 7,
	timezone: systemTimezone(),
	maxAgeMs: 6 * 3600_000,
	rotateBytes: 5 * 1024 * 1024,
	startAt: "end",
};

/** The machine's own time zone, which is what "7 in the morning" means unless `timezone` in alert-desk.json says otherwise. */
export function systemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export const inboxPath = (env: Record<string, string | undefined>, home: string) =>
	env.ALERT_DESK_INBOX || `${home}/.cache/alert-desk/inbox.jsonl`;

/** Pure: the config from a parsed file. A wrong type falls back to the default; nothing throws. */
export function parseConfig(raw: unknown): DeskConfig {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const num = (k: string, d: number, min: number) =>
		typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k] as number) >= min ? (o[k] as number) : d;
	return {
		enabled: o.enabled !== false,
		windowMs: num("windowMinutes", DEFAULTS.windowMs / 60_000, 0) * 60_000,
		repeatMs: num("repeatHours", DEFAULTS.repeatMs / 3600_000, 0) * 3600_000,
		dailyCap: Math.floor(num("dailyCap", DEFAULTS.dailyCap, 0)),
		morningHour: Math.min(23, Math.floor(num("morningHour", DEFAULTS.morningHour, 0))),
		timezone: typeof o.timezone === "string" && o.timezone ? o.timezone : DEFAULTS.timezone,
		maxAgeMs: num("maxAgeHours", DEFAULTS.maxAgeMs / 3600_000, 0) * 3600_000,
		rotateBytes: num("rotateBytes", DEFAULTS.rotateBytes, 1024),
		startAt: o.startAt === "beginning" ? "beginning" : DEFAULTS.startAt,
	};
}
/** The desk's settings: the `alertDesk` section of config.json (else the legacy alert-desk.json), or the defaults. */
export function readConfig(conf: string): DeskConfig {
	try {
		return parseConfig(cfg(conf, "alertDesk"));
	} catch {
		return { ...DEFAULTS };
	}
}

// ---- the morning sources and the standing prompt ------------------------------------------------------
