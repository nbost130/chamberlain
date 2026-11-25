/** A standalone ULID names a run, even when it is written in text instead of passed as a field. */
export const runIdsIn = (text: string): string[] =>
	[...text.matchAll(/(?<![a-z0-9])[0-7][0-9a-hjkmnp-tv-z]{25}(?![a-z0-9])/gi)].map(([id]) => id.toUpperCase());

export const oneLine = (s: string, n = 110) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/* ---------- refs ---------- */
