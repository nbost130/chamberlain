import { afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Server, WaitingDeps } from "../adapters/t3/wait-ctx.ts";
import { createT3Waiting } from "../adapters/t3/waiting.ts";
import type { Adapter } from "../core/adapter/adapter.ts";
import { createWaiting, threadSender } from "../web/waiting.ts";
import { memStore } from "./store.ts";

/** The page's mirror over T3 servers: one T3 reader per server (kept between polls, as the adapter keeps its own), listed and answered through the aggregator. */
type MirrorDeps = Pick<WaitingDeps, "conf" | "log" | "connect" | "timeoutMs" | "linker"> & {
	servers: () => Server[];
	skipThreads: () => string[];
	links?: Record<string, string>;
};

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useAdaptersT3WaitingFixtures() {
	function adapters(d: MirrorDeps) {
		const readers = new Map<string, ReturnType<typeof createT3Waiting>>();
		const pairs = () =>
			d.servers().map((server) => {
				const key = `${server.name}\0${server.operateTokenFile}`;
				let w = readers.get(key);
				if (!w) {
					w = createT3Waiting({
						server,
						conf: d.conf,
						log: d.log,
						connect: d.connect,
						timeoutMs: d.timeoutMs,
						linker: d.linker,
					});
					readers.set(key, w);
				}
				return {
					server: server as never,
					adapter: {
						id: "t3",
						capabilities: ["listWaiting", "answer", "send"],
						listWaiting: w.listWaiting,
						answer: w.answer,
						send: w.send,
					} as unknown as Adapter,
				};
			});
		return pairs;
	}

	const createMirror = (d: MirrorDeps) =>
		createWaiting({ store: memStore(), servers: adapters(d), skipThreads: d.skipThreads, links: d.links, log: d.log });

	const threadSenderFor = (d: MirrorDeps) => threadSender(adapters(d));

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (requestId: string, over: Record<string, unknown> = {}) => ({
		type: "user_input_request",
		status: "waiting",
		requestId,
		questions: [
			{
				id: "0",
				header: "Pick",
				question: "Approve one more round?",
				options: [
					{ label: "Approve (Recommended)", description: "Approve (Recommended)" },
					{ label: "Hold", description: "keep it held" },
				],
			},
		],
		...over,
	});

	const T = { id: "th-1", title: "Code improvements", pendingRuntimeRequest: { id: "r1" } };

	function rig(
		opts: {
			operate?: boolean;
			items?: () => unknown[];
			fail?: (token: string) => string | undefined;
			linker?: WaitingDeps["linker"];
			links?: Record<string, string>;
			/** The waiting thread's id (default `th-1`). */
			threadId?: string;
		} = {},
	) {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-mirror-`);
		dirs.push(conf);
		mkdirSync(conf, { recursive: true });
		for (const f of ["read-token", ...(opts.operate === false ? [] : ["op-token"])]) {
			writeFileSync(`${conf}/${f}`, `tok-${f}`);
			chmodSync(`${conf}/${f}`, 0o600);
		}
		let items = opts.items ?? (() => [question("r1")]);
		const sent: { tag: string; payload: any; token: string }[] = [];
		const logs: { e: string; data?: any }[] = [];
		const connect = async (_origin: string, token: string) => {
			const f = opts.fail?.(token);
			if (f) throw Error(f);
			return {
				ws: { close() {} },
				call: async (_tag: string, _payload: unknown, onChunk?: (v: any) => void) => {
					onChunk?.({
						kind: "snapshot",
						snapshot: {
							threads: [
								{ ...T, id: opts.threadId ?? T.id },
								{ id: "skipme", pendingRuntimeRequest: { id: "q" } },
								{ id: "gone", pendingRuntimeRequest: { id: "z" }, archivedAt: "2026-11-10" },
								{ id: "idle" },
							],
						},
					});
				},
				request: async (tag: string, payload: any) => {
					sent.push({ tag, payload, token });
					if (tag === "orchestration.getThreadProjection")
						return { turnItems: payload.threadId === "skipme" ? [question("rq")] : items() };
					return {};
				},
			};
		};
		const servers: Server[] = [
			{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" },
		];
		const m = createMirror({
			conf,
			servers: () => servers,
			skipThreads: () => ["skipme"],
			log: (e, data) => logs.push({ e, data }),
			connect: connect as any,
			linker: opts.linker,
			links: opts.links,
		});
		return {
			m,
			sent,
			logs,
			setItems: (f: () => unknown[]) => {
				items = f;
			},
		};
	}

	const swapped = (requestId: string, q: Record<string, unknown>) =>
		question(requestId, { questions: [{ ...question("x").questions[0], ...q }] });

	const approval = (requestId: string, over: Record<string, unknown> = {}) => ({
		type: "approval_request",
		status: "waiting",
		requestId,
		requestKind: "command",
		prompt: "true",
		reason: "harmless test",
		...over,
	});

	// ---- goal proposals ----
	const GOAL = "/goal Fix #7478 so the gate reads every body.\n\n## Done when\n1. `bun test` passes.";

	const said = (text: string, over: Record<string, unknown> = {}) => ({
		type: "assistant_message",
		status: "completed",
		messageId: "m1",
		text,
		...over,
	});

	const proposalText = `I read the issue.\n\n🎯 Proposed goal\n\n\`\`\`markdown\n${GOAL}\n\`\`\`\n\nSay the word.`;

	function goalRig(opts: { operate?: boolean; threads?: Record<string, unknown>[] } = {}) {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-goal-`);
		dirs.push(conf);
		for (const f of ["read-token", ...(opts.operate === false ? [] : ["op-token"])]) {
			writeFileSync(`${conf}/${f}`, `tok-${f}`);
			chmodSync(`${conf}/${f}`, 0o600);
		}
		const recent = new Date().toISOString();
		let threads = opts.threads ?? [{ id: "g1", title: "Fix #7478", status: "completed", updatedAt: recent }];
		let items: unknown[] = [said(proposalText)];
		let runs: unknown[] = [{ status: "completed" }];
		const sent: { tag: string; payload: any; token: string }[] = [];
		const connect = async (_o: string, token: string) => ({
			ws: { close() {} },
			call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
				onChunk?.({ kind: "snapshot", snapshot: { threads } });
			},
			request: async (tag: string, payload: any) => {
				sent.push({ tag, payload, token });
				return tag === "orchestration.getThreadProjection" ? { turnItems: items, runs } : {};
			},
		});
		const servers: Server[] = [
			{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" },
		];
		const m = createMirror({
			conf,
			servers: () => servers,
			skipThreads: () => [],
			log: () => {},
			connect: connect as any,
		});
		return {
			m,
			sent,
			set: (o: { items?: unknown[]; runs?: unknown[]; threads?: Record<string, unknown>[] }) => {
				if (o.items) items = o.items;
				if (o.runs) runs = o.runs;
				if (o.threads) threads = o.threads;
			},
		};
	}

	return {
		createMirror,
		threadSenderFor,
		dirs,
		question,
		T,
		rig,
		swapped,
		approval,
		GOAL,
		said,
		proposalText,
		goalRig,
	};
}
