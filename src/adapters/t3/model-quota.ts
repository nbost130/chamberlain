import type { Catalog } from "./model-catalog.ts";

/** Match T3's model-specific usage pools. A consumed pool with no reset needs a recent successful sample. */
export function modelQuotaExhausted(provider: Catalog["providers"][number], model: string, now = Date.now()): boolean {
	const limits = provider.usageLimits;
	if (!limits || limits.unavailable) return false;
	const age = now - Date.parse(limits.checkedAt ?? "");
	const full = limits.windows.filter(
		(window) =>
			Number.isFinite(window.usedPercent) &&
			window.usedPercent >= 100 &&
			(window.resetsAt ? Date.parse(window.resetsAt) > now : age >= 0 && age <= 15 * 60_000),
	);
	if (provider.driver === "claudeAgent") {
		const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "_");
		return full.some(({ id }) => {
			if (id === "five_hour" || id === "seven_day") return true;
			const scope = id?.startsWith("seven_day_") && id.slice("seven_day_".length);
			return Boolean(scope && `_${slug}_`.includes(`_${scope}_`));
		});
	}
	if (provider.driver === "cursor") {
		const apiFull = full.some((window) => window.id === "apiPercentUsed");
		return (
			apiFull &&
			(!/^(auto|default|grok|composer)/.test(model) || full.some((window) => window.id === "autoPercentUsed"))
		);
	}
	if (provider.driver === "opencode")
		return full.some((window) => !window.id?.startsWith("go_") || model.startsWith("opencode-go/"));
	if (provider.driver === "antigravity") {
		const family = /^(gemini|claude|gpt)-/.exec(model)?.[1];
		return full.some((window) => {
			const pool = /^(gemini|claude|gpt|3p)-/.exec(window.id ?? "")?.[1];
			return !family || !pool || family === pool || (pool === "3p" && family !== "gemini");
		});
	}
	return full.length > 0;
}
