/** What one T3 server's waiting-card adapter is made of, shared by its listing (./wait-scan.ts) and its answers (./wait-answer.ts). */
import type { ThreadLinks } from "../../core/adapter.ts";
import type { openWithin } from "./ping.ts";
import type { Rpc } from "./rpc.ts";
import type { T3Server } from "./server.ts";
import type { Run, TurnItem } from "./wait-cards.ts";

export type Server = Pick<T3Server, "name" | "origin" | "tokenFile" | "operateTokenFile">;

export type WaitingDeps = {
	server: Server;
	conf: string;
	log: (event: string, data?: Record<string, unknown>) => void;
	connect?: (origin: string, token: string) => Promise<Pick<Rpc, "request" | "call"> & { ws: { close(): void } }>;
	/** Per-call deadline; tests shorten it. */
	timeoutMs?: number;
	/** The server's thread links (./links.ts). A card links to its thread through it unless the page gives a `linkBase`. */
	linker?: { links(threadId: string): ThreadLinks | undefined; ready(): Promise<void> };
};

/** What one T3 server's adapter is made of: its settings and the calls every read and answer goes through. */
export type Ctx = {
	d: WaitingDeps;
	s: Server;
	ms: number;
	secrets: () => (string | undefined)[];
	/** A projection in the expected shape, or a throw (projection.ts): a malformed one never reads as "nothing waiting". */
	project: (rpc: { request: Rpc["request"] }, threadId: string) => Promise<Projected>;
	open: (token: string) => ReturnType<typeof openWithin>;
	/** server\0threadId -> the updatedAt last read and the proposal found then, so an unchanged thread isn't re-read. */
	goalSeen: Map<string, GoalSeen>;
};
export type Projected = { turnItems: TurnItem[]; runs?: Run[] };
export type GoalSeen = { updatedAt: string; proposal?: { messageId: string; goal: string } };
export type Conn = Awaited<ReturnType<typeof openWithin>>;
