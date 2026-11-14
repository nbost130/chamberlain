import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const TOOL = `${import.meta.dir}/t3x.ts`;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

type Projection = Record<string, unknown>;
type Fake = { origin: string; tokens: string[]; commands: Record<string, unknown>[] };

/** A T3 stand-in: the ticket endpoint and an Effect-RPC socket that answers the three calls t3x makes. */
function fakeT3(projection: Projection, threads: unknown[]): Fake {
	const seen: Fake = { origin: "", tokens: [], commands: [] };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/api/auth/websocket-ticket") {
				seen.tokens.push(String(req.headers.get("authorization")));
				return Response.json({ ticket: "tkt" });
			}
			if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
			return new Response("no", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				const m = JSON.parse(String(raw)) as { _tag: string; id?: string; tag?: string; payload?: any };
				if (m._tag !== "Request") return;
				const exit = (value: unknown) =>
					ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value } }));
				if (m.tag === "orchestration.subscribeShell")
					ws.send(
						JSON.stringify({
							_tag: "Chunk",
							requestId: m.id,
							values: [{ kind: "snapshot", snapshot: { threads } }],
						}),
					);
				else if (m.tag === "orchestration.getThreadProjection") exit(projection);
				else if (m.tag === "orchestration.dispatchCommand") {
					seen.commands.push(m.payload);
					exit({});
				}
			},
		},
	});
	cleanups.push(() => server.stop(true));
	seen.origin = `http://127.0.0.1:${server.port}`;
	return seen;
}

/** A config directory with one server "fake" (a read token, and an operate token unless `readOnly`), and a runner for t3x. */
function world(origin: string, readOnly = false) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-t3x-`);
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const conf = `${root}/conf`,
		state = `${root}/state`;
	mkdirSync(`${conf}/secrets`, { recursive: true, mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	const put = (name: string, body: string) => writeFileSync(`${conf}/${name}`, body, { mode: 0o600 });
	put("secrets/read-token", "READ-TOKEN");
	put("secrets/operate-token", "OPERATE-TOKEN");
	put(
		"config.json",
		JSON.stringify({
			schemaVersion: 1,
			servers: [
				{
					name: "fake",
					adapter: "t3",
					origin,
					tokenFile: "read-token",
					...(readOnly ? {} : { operateTokenFile: "operate-token" }),
				},
			],
		}),
	);
	return async (...args: string[]) => {
		const p = Bun.spawn([process.execPath, TOOL, ...args], {
			env: { ...process.env, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { out, err, code };
	};
}

const waiting = (requestId: string, questions: unknown[]) => ({
	type: "user_input_request",
	status: "waiting",
	requestId,
	questions,
});
const question = {
	id: "q1",
	header: "Merge",
	question: "Merge it?",
	options: [{ label: "Yes", description: "do it" }],
};

describe("t3x threads", () => {
	test("lists live top-level threads, one line each, and skips settled, archived and child ones", async () => {
		const fake = fakeT3({}, [
			{ id: "t-1", status: "running", title: "One", pendingRuntimeRequest: true, snoozedUntil: "later" },
			{ id: "t-2", status: "idle", title: "Two" },
			{ id: "t-3", status: "idle", title: "Settled", settledAt: "x" },
			{ id: "t-4", status: "idle", title: "Archived", archivedAt: "x" },
			{ id: "t-5", status: "idle", title: "Child", lineage: { parentThreadId: "p" } },
		]);
		const r = await world(fake.origin)("threads", "fake");
		expect(r.out).toBe('running | t-1 | "One" | PENDING | snoozed\nidle | t-2 | "Two"\n');
		expect(r.code).toBe(0);
		expect(fake.tokens).toEqual(["Bearer READ-TOKEN"]);
	});
});

describe("t3x read", () => {
	test("prints the last two completed assistant messages oldest first, then every waiting question with its options", async () => {
		const fake = fakeT3(
			{
				turnItems: [
					{ type: "assistant_message", status: "completed", text: "first" },
					{ type: "assistant_message", status: "completed", text: "second" },
					{ type: "assistant_message", status: "running", text: "streaming" },
					{ type: "assistant_message", status: "completed", text: "third" },
					waiting("request-abcdefghijklmnop", [question]),
				],
			},
			[],
		);
		const r = await world(fake.origin)("read", "fake", "t-1");
		expect(r.out).toBe(
			"ASSISTANT: second \n---\nASSISTANT: third \n---\nQ[efghijklmnop] Merge: Merge it?\n  - Yes: do it\n",
		);
		expect(fake.tokens).toEqual(["Bearer READ-TOKEN"]);
	});

	test("a missing thread id is refused", async () => {
		const r = await world(fakeT3({}, []).origin)("read", "fake");
		expect(r.code).toBe(1);
		expect(r.err).toBe("threadId required\n");
	});
});

describe("t3x respond", () => {
	const projection = { turnItems: [waiting("req-1", [question])] };

	test("answers the one waiting request by question header and option label, with the operate token", async () => {
		const fake = fakeT3(projection, []);
		const r = await world(fake.origin)("respond", "fake", "t-1", "Merge=Yes");
		expect(r.out).toBe("responded to 1 question(s) on fake:t-1\n");
		expect(fake.tokens).toEqual(["Bearer OPERATE-TOKEN"]);
		expect(fake.commands).toHaveLength(1);
		expect(fake.commands[0]).toMatchObject({
			type: "runtime-request.respond",
			threadId: "t-1",
			requestId: "req-1",
			answers: { q1: "Yes" },
		});
	});

	test("refuses a header that matches no question, a label that is not an option, and a question left unanswered", async () => {
		const w = world(fakeT3(projection, []).origin);
		expect((await w("respond", "fake", "t-1", "Nope=Yes")).err).toBe('no question with header "Nope"\n');
		expect((await w("respond", "fake", "t-1", "Merge=Maybe")).err).toBe('"Maybe" is not an option of "Merge"\n');
		expect((await w("respond", "fake", "t-1")).err).toBe("unanswered: Merge\n");
	});

	test("a label may itself contain '='", async () => {
		const q = { id: "q9", header: "Pick", options: [{ label: "a=b" }] };
		const fake = fakeT3({ turnItems: [waiting("req-9", [q])] }, []);
		await world(fake.origin)("respond", "fake", "t-1", "Pick=a=b");
		expect(fake.commands[0]).toMatchObject({ answers: { q9: "a=b" } });
	});

	test("needs exactly one waiting request", async () => {
		const none = await world(fakeT3({ turnItems: [] }, []).origin)("respond", "fake", "t-1", "Merge=Yes");
		expect(none.err).toBe("expected exactly one waiting request, found 0\n");
		const two = await world(fakeT3({ turnItems: [waiting("a", [question]), waiting("b", [question])] }, []).origin)(
			"respond",
			"fake",
			"t-1",
			"Merge=Yes",
		);
		expect(two.err).toBe("expected exactly one waiting request, found 2\n");
	});
});

describe("t3x send", () => {
	test("steers the newest active run, or starts a run when none is active", async () => {
		const busy = fakeT3(
			{
				runs: [
					{ id: "old", status: "completed" },
					{ id: "r-2", status: "running" },
					{ id: "r-3", status: "done" },
				],
			},
			[],
		);
		const r = await world(busy.origin)("send", "fake", "t-1", "hello", "there");
		expect(r.out).toBe("sent to fake:t-1\n");
		expect(busy.commands[0]).toMatchObject({
			type: "message.dispatch",
			threadId: "t-1",
			text: "hello there",
			createdBy: "agent",
			creationSource: "mcp",
			dispatchMode: { type: "steer_active", targetRunId: "r-2" },
		});
		const idle = fakeT3({ runs: [{ id: "old", status: "completed" }] }, []);
		await world(idle.origin)("send", "fake", "t-1", "hi");
		expect(idle.commands[0]).toMatchObject({ dispatchMode: { type: "start_immediately" } });
	});

	test("needs text", async () => {
		const r = await world(fakeT3({}, []).origin)("send", "fake", "t-1");
		expect(r.err).toBe("text required\n");
	});
});

describe("t3x refusals", () => {
	test("a server with no operate token is read-only for respond and send", async () => {
		const w = world(fakeT3({}, []).origin, true);
		expect((await w("send", "fake", "t-1", "hi")).err).toBe("fake has no operateTokenFile; it is read-only\n");
		expect((await w("respond", "fake", "t-1", "A=B")).err).toBe("fake has no operateTokenFile; it is read-only\n");
	});

	test("an unknown command, with the operate token read, is refused", async () => {
		const r = await world(fakeT3({}, []).origin)("frobnicate", "fake", "t-1");
		expect(r.err).toBe("unknown command frobnicate\n");
	});

	test("a missing command or an unknown server prints the usage naming the servers, and exits 2", async () => {
		const w = world(fakeT3({}, []).origin);
		const r = await w("threads", "nope");
		expect(r.code).toBe(2);
		expect(r.err).toBe("usage: t3x <threads|read|respond|send> <fake> ...\n");
		expect((await w()).code).toBe(2);
	});
});
