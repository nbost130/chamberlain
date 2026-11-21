import { expect, test } from "bun:test";
import { resolveThreadModel } from "./model.ts";
import type { Catalog } from "./model-catalog.ts";
import { modelQuotaExhausted } from "./model-quota.ts";

const now = Date.UTC(2026, 0, 1);
const checkedAt = new Date(now).toISOString();
function provider(driver: string, ids: string[]): Catalog["providers"][number] {
	return {
		driver,
		instanceId: driver,
		enabled: true,
		installed: true,
		models: [{ slug: "selected" }],
		usageLimits: { checkedAt, windows: ids.map((id) => ({ id, usedPercent: 100 })) },
	};
}
test("usage windows apply only to the selected model's available pools", () => {
	const api = provider("cursor", ["apiPercentUsed"]);
	expect(modelQuotaExhausted(api, "grok-4.6", now)).toBe(false);
	expect(modelQuotaExhausted(api, "gpt-6", now)).toBe(true);
	expect(modelQuotaExhausted(provider("cursor", ["autoPercentUsed", "apiPercentUsed"]), "grok-4.6", now)).toBe(true);
	expect(modelQuotaExhausted(provider("opencode", ["go_weekly"]), "external", now)).toBe(false);
	expect(modelQuotaExhausted(provider("antigravity", ["gemini-weekly"]), "claude-opus", now)).toBe(false);
	expect(modelQuotaExhausted(api, "gpt-6", now + 3_600_000)).toBe(false);
});
test("a backup disabled in the destination project is skipped", () => {
	const model = "claude-opus-5-5";
	expect(modelQuotaExhausted(provider("claudeAgent", ["monthly_spend", "seven_day_sonnet"]), model, now)).toBe(false);
	expect(modelQuotaExhausted(provider("claudeAgent", ["seven_day_opus"]), model, now)).toBe(true);
	expect(modelQuotaExhausted(provider("claudeAgent", ["seven_day"]), model, now)).toBe(true);
	const providers = ["primary", "first", "second"].map((id) => provider(id, []));
	providers[0]!.usageLimits = { windows: [{ id: "weekly", usedPercent: 100, resetsAt: "2099-01-01T00:00:00Z" }] };
	const catalog = {
		providers,
		settings: { projectSettingsOverrides: { project: { providerInstances: { first: { enabled: false } } } } },
	};
	const selected = {
		adapter: "t3" as const,
		server: "server",
		instanceId: "primary",
		model: "selected",
		options: {},
		fallbacks: ["first", "second"].map((instanceId) => ({ instanceId, model: "selected", options: {} })),
	};
	expect(resolveThreadModel(selected, catalog, false, "project").instanceId).toBe("second");
	expect(() => resolveThreadModel({ ...selected, model: "invalid" }, catalog, false, "project")).toThrow(
		"not in the provider catalog",
	);
});
