/** One server's watcher, second layer: drafting what a wake says, by the kind of fire, and what recovery makes of a failure. */
import type { ThreadState } from "./adapter.ts";
import { has } from "./adapter-conformance.ts";
import type { WaitingItem, WaitingRead } from "./adapter-waiting.ts";
import { readAfk } from "./afk-held.ts";
import { cardWaitOf, holdCard } from "./card-hold.ts";
import { type Candidate, endKind, questionText, reportKey, routeNeedsInput } from "./decide.ts";
import { clip, type Draft, type Fire, settledNote, waitNoteFor } from "./engine-support.ts";
import { WatcherReads } from "./engine-watcher-reads.ts";
import { type InstructionRead, skipEvent } from "./history.ts";
import type { Question } from "./questions.ts";
import { outcomeOf } from "./recover.ts";
import type { Handling } from "./recover-state.ts";
import { type ReportOutcome, settleReport } from "./report.ts";

export class WatcherDrafts extends WatcherReads {
	/** Decides a key now, for this fire and for any other that asks; the notification itself is written by the commit below. */
	protected stage(mine: string[], k: string) {
		this.core.staged.add(k);
		if (!mine.includes(k)) mine.push(k);
	}

	/** Fills in what the wake will say for the kind of fire; false when the fire ends here with no wake. */
	protected async draftWake(f: Fire, ended: InstructionRead | undefined): Promise<boolean> {
		const { c, live, draft, mine } = f;
		if (c.kind === "turn_ended") return this.draftTurnEnded(f, ended as InstructionRead);
		if (c.kind === "needs_input") return this.draftNeedsInput(live, draft, mine);
		if (c.kind === "failed") return this.draftFailed(live, draft);
		return true;
	}

	/** With no history to read, nothing says who instructed a thread: every top-level turn end is its own report. */
	protected reportOf(c: Candidate, key: string | undefined) {
		return this.inspect ? key : this.core.notified.has(c.key) ? undefined : c.key;
	}

	protected async draftTurnEnded(f: Fire, read: InstructionRead): Promise<boolean> {
		const { c, live, draft } = f;
		// A hung child must not swallow a report, so the wait below covers it. It stays no reason to wake anyone yet.
		const children =
			this.liveChildren(live.id) > 0 ||
			(await this.subagents(live.id).catch(this.readFailed("subagents", live.id, 0))) > 0;
		draft.excerpt = await this.lastMessage(c.thread.id).catch(this.readFailed("last message", live.id, ""));
		const kind = endKind(draft.excerpt);
		draft.stalled = kind === "stall";
		if (!children && kind !== "plain") return true;
		return this.settleTurn(f, read, children);
	}

	/** The wait that lets a finished turn's report settle (a PR update often follows); false when there is nothing to report. */
	protected async settleTurn(f: Fire, read: InstructionRead, children: boolean): Promise<boolean> {
		const { c, live, draft, mine } = f;
		const { notified, t } = this.core;
		// Each finished turn restarts the window: the wake belongs to the last turn, not the first.
		const due = this.reportOf(c, reportKey(read.items, read.byMachine, notified)) ?? (await this.idleWork(live, read));
		// A failed read can't say the turn has nothing to report, so it goes on to the read after the wait.
		if (!due && read.state !== "failed") {
			this.log(children ? "skip-children-running" : skipEvent(read, "skip-turn-ended"), {
				server: this.srv.name,
				threadId: c.thread.id,
			});
			return false;
		}
		// No await from here to the set: an ssh check above can outlast another fire's whole window.
		const waiting = this.quietUntil.has(live.id);
		this.quietUntil.set(live.id, Date.now() + t.quietMs);
		if (waiting) return false;
		const settled = await this.awaitQuiet(c, live);
		if (!settled.wake) {
			this.log(settled.event, { server: this.srv.name, threadId: live.id });
			return false;
		}
		draft.waitNote = settledNote(settled);
		draft.idleLine = settled.work;
		draft.stalled = false;
		if (notified.has(settled.key)) return false;
		this.stage(mine, settled.key);
		draft.excerpt = await this.lastMessage(live.id).catch(this.readFailed("last message", live.id, draft.excerpt));
		draft.reported = true;
		return true;
	}

	/** Waits out the quiet window of a finished turn, and says whether the report is still due. */
	protected awaitQuiet(c: Candidate, live: ThreadState): Promise<ReportOutcome> {
		return settleReport({
			now: () => Date.now(),
			sleep: (ms) => Bun.sleep(ms),
			quietUntil: () => this.quietUntil.get(live.id) ?? 0,
			state: () => this.states.get(live.id),
			children: async () =>
				this.liveChildren(live.id) + (await this.subagents(live.id).catch(this.readFailed("subagents", live.id, 0))),
			oldCards: () => this.oldCards.get(live.id) ?? new Set(),
			read: () => this.instructionRead(live.id),
			reportKey: (r) => this.reportOf(c, reportKey(r.items, r.byMachine, this.core.notified)),
			idleWork: (th, r) => this.idleWork(th, r),
		}).finally(() => this.quietUntil.delete(live.id));
	}

	/** A request is seen once per (server, request ID): two servers may use the same request ID. */
	protected reqKey(requestId: string) {
		return `req:${this.srv.name}:${requestId}`;
	}

	/** What the thread waits on now; the projection can lag the status by a moment, so an empty answer is read once more. */
	protected async readWaiting(live: ThreadState): Promise<WaitingRead> {
		let read = await this.waitingRead(live.id);
		// The projection can lag the status by a moment: look once more before calling the wait empty.
		if (this.inspect && read.ok && !read.cards.length && !live.pendingRequestId) {
			await Bun.sleep(this.core.t.lagMs);
			read = await this.waitingRead(live.id);
		}
		// A failed read is not "nothing waiting": it is logged, and the thread's own status is the request, so it still wakes.
		if (!read.ok)
			this.log("read-failed", { server: this.srv.name, threadId: live.id, what: "waiting items", error: read.reason });
		return read;
	}

	protected async draftNeedsInput(live: ThreadState, draft: Draft, mine: string[]): Promise<boolean> {
		if (!live.pendingRequestId && live.status !== "waiting") return false;
		const read = await this.readWaiting(live);
		const items: WaitingItem[] = read.ok ? read.cards : [];
		// With nothing to read, or a card item the adapter had to skip, the thread's own status is the request: a skipped card
		// must not read as "nothing waiting".
		const route = routeNeedsInput(
			items,
			Boolean(live.pendingRequestId) || !this.inspect || !read.ok || Boolean(read.ignored?.length),
			Boolean(readAfk(this.core.store)),
		);
		if (route === "skip-empty") {
			this.log("skip-empty-wait", { server: this.srv.name, threadId: live.id });
			return false;
		}
		if (route === "hold") {
			for (const i of items.filter((x) => !this.core.notified.has(this.reqKey(x.requestId))))
				await this.holdCard(live, i);
			return false;
		}
		const fresh = items.filter((i) => !this.core.notified.has(this.reqKey(i.requestId)));
		if (items.length && !fresh.length) {
			this.log("skip-request-seen", { server: this.srv.name, threadId: live.id });
			return false;
		}
		for (const i of fresh) this.stage(mine, this.reqKey(i.requestId));
		draft.waitNote = waitNoteFor(fresh, this.adapter);
		// Carrying the question saves the Steward a thread read on most wakes.
		draft.question = questionText(fresh.flatMap((i) => i.questions));
		draft.excerpt = await this.lastMessage(live.id).catch(this.readFailed("last message", live.id, ""));
		return true;
	}

	/** Holds one card for the operator's return, and files the pointer question that leads to it. */
	protected async holdCard(live: ThreadState, i: WaitingItem) {
		const { store } = this.core;
		// The record that it was seen, the question that points to the card and the hold the operator will read are one
		// transaction: a crash between them would leave the request marked seen with nothing on the queue or held.
		// Only the card's kind, request ID and label travel (card-hold.ts); its questions and any value never do.
		let filed: Question | undefined;
		store.tx(() => {
			this.core.markNotified(this.reqKey(i.requestId));
			filed = holdCard(store, cardWaitOf(i, { thread: live.title, server: this.srv.name, threadId: live.id })).question;
		});
		this.log("held-by-daemon", { server: this.srv.name, threadId: live.id, kind: i.type });
		// A new pointer question is shown where the operator reads, like any other; a secret's never is. Best effort: it is on the queue page either way.
		if (filed && !filed.secret && !this.core.DRY) await this.postCardQuestion(live, filed);
	}

	protected async postCardQuestion(live: ThreadState, filed: Question) {
		await this.adapter.post(filed, {}).then(
			(r) => {
				if (!r.ok)
					this.log("card-question-post-failed", {
						server: this.srv.name,
						threadId: live.id,
						detail: clip(r.detail, 200),
					});
			},
			(e) =>
				this.log("card-question-post-failed", {
					server: this.srv.name,
					threadId: live.id,
					detail: String(e).slice(0, 200),
				}),
		);
	}

	protected async draftFailed(live: ThreadState, draft: Draft): Promise<boolean> {
		if (live.status !== "failed") return false;
		const h = await this.recover(live);
		if (h.stop) return false;
		if (h.note) draft.waitNote = h.note;
		if (h.what) draft.failedWhat = h.what;
		return true;
	}

	/**
	 * Stalled-thread recovery for one failed thread (src/core/recover.ts). It either settles the failure without a wake (a retry is
	 * scheduled, the outage breaker holds, it was seen already), or says how the ordinary failed wake should read. An adapter that
	 * cannot read a failure or send, a dry run, and a recovery turned off all keep the wake exactly as it was.
	 */
	protected async recover(live: ThreadState): Promise<{ stop?: true; note?: string; what?: string }> {
		const forced = this.forced.get(live.id);
		if (forced) {
			this.forced.delete(live.id);
			return { note: forced };
		}
		const recovery = this.core.recovery;
		if (
			!recovery ||
			this.core.DRY ||
			!this.adapter.inspect?.failure ||
			!this.adapter.inspect.look ||
			!has(this.adapter, "send")
		)
			return {};
		const h: Handling = await recovery.onFailure(live);
		const o = outcomeOf(h, { thread: live.title, server: this.srv.name, threadId: live.id }, this.core.timing);
		if (o.ask) await this.core.raise(o.ask);
		return {
			...(o.stop ? { stop: true as const } : {}),
			...(o.note ? { note: o.note } : {}),
			...(o.what ? { what: o.what } : {}),
		};
	}
}
