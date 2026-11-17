import { expect, test } from "bun:test";
import { failureFreshness } from "../../core/engine/failure-freshness.ts";
import { createT3Adapter } from "./index.ts";

test("a disconnected T3 reader holds stale failures, including already queued work", async () => {
	const adapter = createT3Adapter({
		server: { name: "offline", adapter: "t3", origin: "http://127.0.0.1:1", tokenFile: "absent" },
		conf: "/nonexistent",
		state: "/nonexistent",
		log: () => {},
		alarm: () => {},
		steward: () => undefined,
		readPrivate: () => undefined,
	});
	await expect(adapter.inspect!.look!("recovered")).rejects.toThrow("disconnected");
	expect(await failureFreshness(adapter.inspect, "recovered")).toBe("wait");
});
