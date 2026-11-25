/**
 * The decision-queue web app: the queue, an item's detail and the rulings page, over one JSON API. Everything that
 * touches the network or the clock comes in through deps, so the tests drive the real handler.
 */
import { ranked } from "../core/items/questions-wake.ts";
import { type AnswerIn, acceptAll, answer } from "./app-answer.ts";
import { type AppDeps, type Ctx, makeCtx } from "./app-ctx.ts";
import { fail, inlineCors, withSecurity } from "./app-http.ts";
import {
	capabilityProof,
	checkOrigin,
	isOpen,
	isShell,
	linkRedirect,
	postAllowed,
	restrictedRefusal,
	servePage,
	staticResponse,
	unauthorized,
} from "./app-pages.ts";
import { recover } from "./app-relay.ts";
import { api } from "./app-routes.ts";
import { authorityOf } from "./view-key.ts";

async function handle(ctx: Ctx, req: Request): Promise<Response> {
	const { d } = ctx;
	const url = new URL(req.url);
	const gate = checkOrigin(d, req, url);
	if (gate instanceof Response) return gate;
	const served = staticResponse(d, req, url);
	if (served) return served;
	const proof = capabilityProof(d, req, url, gate);
	if (!proof.full && !proof.byPageKeyHeader && !proof.byViewKey) return unauthorized(req, url, gate.allowed);
	const refused = restrictedRefusal(req, url, proof, gate.inline);
	if (refused) return refused;
	if (proof.byLink && (isShell(url.pathname) || isOpen(url.pathname))) return linkRedirect(d, req, url);
	if (req.method === "POST" && !postAllowed(req, gate)) return withSecurity(fail(403, "refused"));
	if (url.pathname.startsWith("/api/")) {
		const r = withSecurity(await api(ctx, req, url, authorityOf(gate.inline || !proof.full, proof.byViewKey)));
		return gate.allowed ? inlineCors(r) : r;
	}
	// A request whose only proof is the view key is held to its list on evidence too: only a question its reads show it.
	return servePage(ctx, req, url, proof.byViewKey && !proof.full);
}

export function createApp(d: AppDeps) {
	const ctx = makeCtx(d);
	return {
		fetch: (req: Request) => handle(ctx, req),
		answer: (id: string, body: AnswerIn, by: "page" | "batch", inline = false) => answer(ctx, id, body, { by, inline }),
		acceptAll: (ids: unknown) => acceptAll(ctx, ids),
		recover: () => recover(ctx),
		/** How many questions wait on the principal: the count the Decisions thread title shows. */
		openCount: () =>
			ranked(ctx.state().values()).filter((i) => i.kind !== "idea").length + (d.mirror?.list().length ?? 0),
		idle: async () => {
			while (ctx.background.size) await Promise.all([...ctx.background]);
		},
	};
}
