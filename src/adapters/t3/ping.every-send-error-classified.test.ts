/** ping, continued: see ping.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRpcPing, NOT_SENT, sendFailure } from "./ping.ts";

describe("every send error is classified before the commit, and only a confirmed acceptance is sent", () => {
	const dir = mkdtempSync(`${tmpdir()}/ping-r3-`);
	writeFileSync(`${dir}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "laptop", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const root = dir;
	const failedProj = { runs: [{ id: "r1", ordinal: 1, status: "failed" }], turnItems: [] };
	/** A connection that fails at one stage. */
	const stage =
		(at: "connect" | "projection" | "dispatch-refused" | "dispatch-timeout" | "dispatch-dropped" | "ok") =>
		async () => {
			if (at === "connect") throw Error("connect ECONNREFUSED");
			return {
				ws: { close() {} },
				request: async (m: string) => {
					if (m === "orchestration.getThreadProjection") {
						if (at === "projection") throw Error("projection read timed out");
						return failedProj;
					}
					if (at === "dispatch-refused") throw Error(`rpc failure: ${JSON.stringify({ _tag: "Failure" })}`);
					if (at === "dispatch-timeout") throw Error("send timed out after 10000 ms");
					if (at === "dispatch-dropped") throw Error("socket closed");
					return {};
				},
			};
		};
	const run = (at: Parameters<typeof stage>[0]) => {
		const conn = stage(at);
		return createRpcPing({ server, conf: root, connect: conn as never })("t1", "retry", "recover:t1:1", "daemon");
	};
	test("a failure before the dispatch call (connect, projection read) is not sent", async () => {
		for (const at of ["connect", "projection"] as const) {
			const r = await run(at);
			expect(r.ok).toBe(false);
			expect(r.detail.startsWith(NOT_SENT)).toBe(true);
		}
	});
	test("T3 refusing the command outright is not sent", async () => {
		const r = await run("dispatch-refused");
		expect(r.ok).toBe(false);
		expect(r.detail.startsWith(NOT_SENT)).toBe(true);
	});
	test("a timeout or a dropped socket after the dispatch may have landed: it carries no 'not sent' prefix", async () => {
		for (const at of ["dispatch-timeout", "dispatch-dropped"] as const) {
			const r = await run(at);
			expect(r.ok).toBe(false);
			expect(r.detail.startsWith(NOT_SENT)).toBe(false);
		}
	});
	test("only a resolved dispatch is a confirmed send", async () => {
		expect((await run("ok")).ok).toBe(true);
	});
	test("sendFailure: the token is redacted, and the prefix depends only on whether the dispatch was reached and whether T3 refused it", () => {
		expect(sendFailure(Error("x OPSECRET y"), false, ["OPSECRET"])).toBe("not sent: Error: x [redacted] y");
		expect(sendFailure(Error("socket closed"), true, [])).toBe("Error: socket closed");
		expect(sendFailure(Error("rpc failure: {}"), true, [])).toMatch(/^not sent: /);
	});
});
