/** t */

export const oneLine = (s: string, n = 110) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/* ---------- refs ---------- */
