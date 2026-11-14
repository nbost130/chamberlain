import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { t3Linker } from "../adapters/t3/links.ts";
import type { Adapter } from "../core/adapter.ts";
import type { WaitingCard } from "../core/adapter-waiting.ts";
import { newToken } from "../core/capability.ts";
import { askQuestion, type Question } from "../core/questions.ts";
import { createApp } from "../web/app.ts";
import { createLinker } from "../web/thread-links.ts";
import type { ServerAdapter } from "../web/waiting.ts";
import { memoryCapability } from "./capability.ts";
import { memStore } from "./store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebThreadLinksFixtures() {
	/** A T3-shaped adapter over the real link builder: only `threadLinks`, which is all the linker reads. */
	const t3 = (name: string, entry: Record<string, unknown>): ServerAdapter => {
		const l = t3Linker({ origin: `http://${name}:3773`, ...entry }, { read: async () => undefined });
		return {
			server: { name, adapter: "t3", ...entry },
			adapter: { id: "t3", capabilities: ["threadLinks"], threadLinks: l.links } as unknown as Adapter,
		};
	};

	/** The live layout: a home server with no environmentId (its id given for links), and two linked servers. */
	const SERVERS = [
		t3("mithrandir", { linkEnvironmentId: "env-home" }),
		t3("mac", { environmentId: "env-mac" }),
		t3("omar", { environmentId: "env-omar" }),
	];

	const T1 = "11111111-2222-3333-4444-555555555555";

	const T2 = "66666666-7777-8888-9999-000000000000";

	const LAUNCHED = `mcp:launch:${"ab12".repeat(16)}`;

	const LAUNCHED_PATH = encodeURIComponent(LAUNCHED);

	// ---- the page: what the queue carries and what /open does ----

	const HOST = "127.0.0.1:3790";

	const ORIGIN = `http://${HOST}`;

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const card: WaitingCard = {
		id: "C-aaaaaaaaaaaa",
		type: "approval",
		server: "mac",
		threadId: LAUNCHED,
		threadTitle: "Build it",
		requestId: "r1",
		question: "command",
		options: [],
		answerable: false,
		link: `t3-thread://v2/env-mac/${LAUNCHED}`,
		sig: "s",
	};

	function page(
		servers = SERVERS,
		secretRequest?: (q: {
			server: string;
			threadId?: string;
			cardRequest?: string;
			createdAt: string;
		}) => "open" | "ended" | undefined,
		more: Question[] = [],
	) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-open-`);
		dirs.push(root);
		for (const f of ["index.html", "app.js", "app.css", "inline.js"]) writeFileSync(`${root}/${f}`, `/* ${f} */`);
		const store = memStore();
		const q: Question = {
			id: "Q-abcd",
			kind: "product",
			title: "Pick one",
			context: "c",
			options: [{ label: "A" }, { label: "B" }],
			recommended: 0,
			thread: "Mobile app",
			server: "mithrandir",
			threadId: T1,
			createdAt: "2026-11-09T10:00:00.000Z",
		};
		askQuestion(store, q);
		askQuestion(store, { ...q, id: "Q-efgh", server: "laptop-gone", threadId: T2 });
		for (const m of more) askQuestion(store, m);
		const token = newToken();
		const app = createApp({
			capability: memoryCapability(token, { now: 1_800_000_000_000 }).capability,
			store,
			state: `${root}/state`,
			log: () => {},
			hosts: [HOST],
			staticDir: root,
			links: createLinker({ servers: () => servers }),
			mirror: {
				list: () => [card],
				answer: async () => ({ status: 200, body: {} }),
				...(secretRequest ? { secretRequest } : {}),
			},
		});
		const get = (path: string, headers: Record<string, string> = {}) =>
			app.fetch(new Request(`${ORIGIN}${path}`, { headers: { host: HOST, ...headers } }));
		return { token, get };
	}

	return { t3, SERVERS, T1, T2, LAUNCHED, LAUNCHED_PATH, ORIGIN, page };
}
