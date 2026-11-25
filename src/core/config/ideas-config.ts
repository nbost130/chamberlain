/** The queue's idea admission limits, including the time zone that defines a filing day. */
const DEFAULTS = { timeZone: "UTC", dailyCap: 2, perThreadDailyCap: 1, openCap: 5, declineDays: 30 };
const LIMITS = ["dailyCap", "perThreadDailyCap", "openCap", "declineDays"] as const;

export function parseIdeas(raw: unknown): typeof DEFAULTS {
	if (raw == null) return DEFAULTS;
	if (typeof raw !== "object" || Array.isArray(raw)) throw Error('config.json: "ideas" must be an object');
	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (!Object.hasOwn(DEFAULTS, key)) throw Error(`config.json: unknown key "ideas.${key}"`);
	}
	const parsed = { ...DEFAULTS };
	for (const key of LIMITS) {
		const value = config[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw Error(`config.json: "ideas.${key}" must be a non-negative integer`);
		parsed[key] = value;
	}
	return { ...parsed, timeZone: timeZone(config.timeZone ?? DEFAULTS.timeZone) };
}

function timeZone(zone: unknown): string {
	if (typeof zone !== "string" || !/^[A-Za-z]/.test(zone))
		throw Error('config.json: "ideas.timeZone" must be an IANA time zone');
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
	} catch {
		throw Error('config.json: "ideas.timeZone" must be an IANA time zone');
	}
	return zone;
}
