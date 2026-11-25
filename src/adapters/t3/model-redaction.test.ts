import { expect, test } from "bun:test";
import { modelServer } from "../../testing/model-server.ts";
import { repostView } from "./post.ts";

test("encoded view capabilities are scrubbed before RPC diagnostics truncate them", async () => {
	const s = modelServer();
	const key = "capability-for-test-0123456789abcdefghijklmnopqrstuvwxyz";
	const encoded = [...Buffer.from(key)].map((b) => `%${b.toString(16)}`).join("");
	try {
		for (const form of [encoded, encoded.toUpperCase()]) {
			s.state.failSend = true;
			s.state.error = `${"x".repeat(130)}${form}`;
			const result = await repostView(s.conf, "https://example.test", key);
			expect(result.ok).toBe(false);
			expect(result.reason).toBe("unknown");
			expect(result.detail).not.toContain("xxxxxxxx");
			expect(result.detail).not.toContain(form.slice(0, 12));
			expect(result.detail).not.toContain(key);
		}
	} finally {
		s.close();
	}
});
