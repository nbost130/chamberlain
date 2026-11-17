import { expect, test } from "bun:test";
import { senderViolations } from "./architecture-relay-scans.test.ts";

test("the inference HTTP exception never permits access to a wake transport", () => {
	expect(senderViolations("core/llm/reader.ts", 'fetch(endpoint, { method: "POST" })')).toEqual([]);
	for (const code of [
		'wake.send("id", "message")',
		"adapter.wake",
		"postWebhook(url, id, message)",
		'readSecret(conf, "wake-url")',
	])
		expect(senderViolations("core/llm/reader.ts", code).length).toBeGreaterThan(0);
	expect(senderViolations("core/unapproved.ts", 'fetch(endpoint, { method: "POST" })').length).toBeGreaterThan(0);
});
