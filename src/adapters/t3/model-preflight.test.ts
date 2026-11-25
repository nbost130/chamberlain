import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PREFLIGHT_DETAILS } from "../../core/delivery/preflight.ts";
import { logFor, obsFor } from "../../core/log.ts";
import { openStore } from "../../core/store/sqlite-store.ts";
import { within } from "../../core/within.ts";
import { repost } from "../../decisions.ts";
import { base } from "../../testing/ask-fixtures.ts";
import { modelServer } from "../../testing/model-server.ts";
import { eventRows } from "../../testing/obs.ts";
import { testRelay } from "../../testing/relay.ts";
import { configuredPing } from "./model.ts";
import { preflightFailure } from "./model-preflight.ts";
import { modelWake } from "./model-wake.ts";
import { webhookWake } from "./wake.ts";

type Server = ReturnType<typeof modelServer>;
const secrets = [
	"https://private.example.test/wake",
	"synthetic-bearer-value",
	"synthetic-provider-reply",
	"synthetic-thread-text",
];
const nested = {
	_tag: "Fail",
	failure: { message: secrets[0], cause: { token: secrets[1], reply: secrets[2], text: secrets[3] } },
};
const delay = 2000;
const view = async () => ({ queueUrl: "http://queue.example.test", capability: "synthetic-view-key" });

function world() {
	const s = modelServer();
	const db = `${s.conf}/queue.db`;
	let store = openStore(db);
	const target = `${s.config.servers[0]!.origin}/wake`;
	s.bindWake(target, s.config.threads.steward);
	const wake = modelWake(
		webhookWake(() => target),
		s.conf,
		"steward",
	);
	const time = { now: 1000 };
	const alerts: string[][] = [];
	const relay = () =>
		testRelay(store, wake, {
			now: () => time.now,
			preflightAlarmAfterMs: delay,
			log: logFor(store),
			alarm: (key, title, summary) => {
				store.items.observe({
					source: "alarm",
					kind: "alarm",
					dedupKey: key,
					payload: { title, summary },
					now: time.now,
				});
				alerts.push([key, title, summary]);
			},
		}).relay;
	return {
		s,
		db,
		time,
		alerts,
		relay,
		get store() {
			return store;
		},
		queue: (id: string) => store.wakes.enqueue({ deliveryId: id, message: "wake", queuedAt: time.now }),
		restart: () => {
			store.close();
			store = openStore(db);
			return relay();
		},
		close: () => {
			store.close();
			s.close();
		},
	};
}

const cases = [
	[
		"active run blocks model switch",
		"busy",
		(s: Server, on: boolean) => {
			s.state.busy = on;
		},
	],
	[
		"exhausted usage window",
		"quota",
		(s: Server, on: boolean) => {
			s.state.exhausted = on;
		},
	],
	[
		"ticket returns HTTP 403",
		"auth",
		(s: Server, on: boolean) => {
			s.state.ticketStatus = on ? 403 : 200;
		},
	],
	[
		"catalog option rejects configured value",
		"unsupported",
		(s: Server, on: boolean) => {
			s.config.models.steward.options.reasoningEffort = on ? "invalid" : "high";
			s.save();
		},
	],
	[
		"catalog lacks configured provider",
		"config",
		(s: Server, on: boolean) => {
			s.state.instanceId = on ? "different-provider" : "other-provider";
		},
	],
	[
		"ticket endpoint returns HTTP 503",
		"unreachable",
		(s: Server, on: boolean) => {
			s.state.ticketStatus = on ? 503 : 200;
		},
	],
	[
		"unrecognized RPC failure with nested cause",
		"unknown",
		(s: Server, on: boolean) => {
			s.state.projectionFailure = on ? nested : undefined;
		},
	],
] as const;

for (const [shape, reason, setFailure] of cases) {
	test(`${shape} → ${reason} event, alarm and recovery`, async () => {
		const w = world();
		try {
			setFailure(w.s, true);
			const delayed = reason === "busy" || reason === "unreachable";
			const key = reason === "quota" ? "model-quota" : "wake-preflight";
			w.queue("first");
			await w.relay().pass();
			const event = w.store.events.query({ events: ["deliver-preflight-failed"] })[0];
			expect(event).toMatchObject({ reason, detail: PREFLIGHT_DETAILS[reason] });
			expect(String(event?.detail).length).toBeLessThanOrEqual(120);
			const [stored] = eventRows(obsFor(w.store), "event = 'wake.preflight-failed'");
			expect(JSON.parse(stored?.data ?? "{}")).toMatchObject({ reason, detail: event?.detail });
			expect(w.store.wakes.find("first")).toMatchObject({ status: "pending", attempts: 0 });
			expect(w.s.posts).toHaveLength(0);
			expect(w.alerts).toHaveLength(delayed ? 0 : 1);
			const before = w.restart();
			w.time.now += delay - 1;
			await before.pass();
			expect(w.alerts).toHaveLength(delayed ? 0 : 1);
			w.time.now++;
			await before.pass();
			expect(w.alerts).toHaveLength(1);
			expect(w.alerts[0]?.[0]).toBe(key);
			expect(w.alerts[0]?.[2]).toContain(String(event?.detail));
			const after = w.restart();
			await after.pass();
			expect(w.alerts).toHaveLength(1);
			setFailure(w.s, false);
			await after.pass();
			expect(w.store.items.get("alarm", key)?.status).toBe("resolved");
			expect(w.store.wakes.find("first")).toMatchObject({ status: "delivered", attempts: 1 });
			// Changing the selection makes the same busy failure possible after a successful send.
			if (reason === "busy") {
				Object.assign(w.s.config.models.steward, { fallbacks: [{ instanceId: "backup", model: "backup-model" }] });
				w.s.state.backupAvailable = true;
				w.s.state.exhausted = true;
				w.s.save();
			}
			setFailure(w.s, true);
			w.queue("second");
			await after.pass();
			expect(w.alerts).toHaveLength(delayed ? 1 : 2);
			w.time.now += delay;
			await after.pass();
			expect(w.alerts).toHaveLength(2);
			expect(w.s.posts).toHaveLength(1);
		} finally {
			w.close();
		}
	});
}

test("nested RPC causes do not leak into the relay log, alarm, on-disk databases or ask stderr", async () => {
	const w = world();
	try {
		w.s.state.projectionFailure = nested;
		w.queue("w1");
		await w.relay().pass();
		const result = await repost(w.s.conf, view);
		expect(result.line).toContain("not sent: unknown");
		const child = Bun.spawn(
			[process.execPath, new URL("../../ask.ts", import.meta.url).pathname, JSON.stringify({ ...base, urgent: true })],
			{
				env: { ...process.env, CHAMBERLAIN_CONF: w.s.conf, CHAMBERLAIN_STATE: w.s.conf },
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const [stderr, stdout, status] = await Promise.all([
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
			child.exited,
		]);
		expect(status).toBe(1);
		expect(stderr).toContain("Decisions post: not sent: unknown");
		const log = JSON.stringify(w.store.events.query({ events: ["deliver-preflight-failed"] }));
		expect(log).toContain("unknown");
		expect(w.alerts).toHaveLength(1);
		w.store.close(); // Flush WAL and observability writes before checking the files.
		const databases = [w.db, `${w.s.conf}/obs.db`].map((path) => readFileSync(path).toString());
		for (const text of [log, JSON.stringify(w.alerts), ...databases, result.line, stderr, stdout])
			for (const value of secrets) expect(text).not.toContain(value);
	} finally {
		w.close();
	}
});

test("a dispatch accepted before disconnect is reported as unconfirmed and never as unsent", async () => {
	const s = modelServer();
	try {
		s.state.loseSendAck = true;
		const result = await repost(s.conf, view);
		expect(result.line).toContain("post could not be confirmed: unreachable");
		expect(result.line).not.toContain("not sent");
		expect(s.accepted).toHaveLength(1);
		expect(s.accepted[0]).toContain("Decisions view reposted.");
		s.state.loseSendAck = false;
		expect((await configuredPing(s.conf, "decisions", "confirmed")).ok).toBe(true);
	} finally {
		s.close();
	}
});

test("a call deadline and a nested network errno are unreachable, while arbitrary text is unknown", async () => {
	const deadline = await within(new Promise<never>(() => {}), 1, secrets[0] ?? "").catch(preflightFailure);
	expect(deadline).toEqual({ ok: false, reason: "unreachable", detail: PREFLIGHT_DETAILS.unreachable });
	for (const error of [
		Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
		new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: secrets[0] } }),
	]) {
		expect(preflightFailure(error)).toEqual(deadline);
	}
	expect(preflightFailure(new Error("unrecognized provider reply says busy timeout"))).toMatchObject({
		reason: "unknown",
	});
});

test("a malformed RPC frame fails preparation without quoting the frame", async () => {
	const s = modelServer();
	try {
		s.state.malformedProjectionFrame = `invalid frame: ${secrets.join(" ")}`;
		const result = await configuredPing(s.conf, "decisions", "must not send");
		expect(result).toMatchObject({ ok: false, reason: "unknown" });
		for (const secret of secrets) expect(result.detail).not.toContain(secret);
		expect(s.accepted).toHaveLength(0);
	} finally {
		s.close();
	}
});
