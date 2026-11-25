import { bool, object, str } from "../config/config-fields.ts";

export type Span = { from: number; to: number };

export function distillSettings(raw: unknown): { timezone: string; chat: boolean } {
	const where = "distill";
	if (raw === undefined) return { timezone: "UTC", chat: false };
	const o = object(raw, where, ["timezone", "chat"]);
	const zone = str(o, "timezone", where, "UTC");
	let timezone: string;
	try {
		timezone = new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
	} catch {
		throw Error("distill: timezone must be a valid time zone");
	}
	return { timezone, chat: bool(o, "chat", where, false) };
}

export const inSpan = (time: number, { from, to }: Span): boolean => time >= from && time < to;

/** Weekly reports use the last complete local ISO week. Other lengths are trailing local calendar days. */
export function distillWindow(now: number, days: number, timezone: string) {
	const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone);
	if (days !== 7) return { span: { from: local.subtract({ days }).epochMilliseconds, to: now } };
	const monday = local.toPlainDate().subtract({ days: local.dayOfWeek - 1 });
	const start = monday.subtract({ weeks: 1 });
	return {
		week: start.toString(),
		span: {
			from: start.toZonedDateTime(timezone).epochMilliseconds,
			to: monday.toZonedDateTime(timezone).epochMilliseconds,
		},
	};
}
