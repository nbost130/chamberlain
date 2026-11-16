/**
 * Queued LIVE→LIVE handoffs: process cache backed by Store.handoffs (issue #76).
 * Recovered on construction so a restart can retry without a new transition for the old run.
 */
import type { ThreadState } from "./adapter.ts";
import type { Candidate } from "./decide.ts";
import { LIVE } from "./decide.ts";
import { WatcherDrafts } from "./engine-watcher-draft.ts";
import { confirmHandoff, type HandoffObservation, type HandoffRecord, rejectedDisposition } from "./handoff.ts";
import { asHandoffRecord, handoffKey } from "./sqlite-handoffs.ts";

export abstract class WatcherHandoffs extends WatcherDrafts {
	/** Queued LIVE→LIVE handoffs awaiting confirmation after the debounce (interval + causing successor). */
	protected pendingHandoffs = new Map<string, HandoffRecord>();

	/** Debounce a candidate into a fire (implemented by Watcher). */
	protected abstract schedule(c: Candidate): void;

	/** Load pending and rejected rows for this server into the process cache (daemon restart recovery). */
	protected loadPendingHandoffs() {
		for (const h of this.core.store.handoffs.listOpen(this.srv.name)) {
			this.pendingHandoffs.set(handoffKey(h.threadId, h.runId), asHandoffRecord(h));
		}
	}

	/** Write-through: keep the Map and the SQLite row in step. */
	protected saveHandoff(key: string, record: HandoffRecord) {
		this.pendingHandoffs.set(key, record);
		this.core.store.handoffs.put(this.srv.name, record);
	}

	/**
	 * Confirm a named turn end. Queued handoffs need one coherent observation; a capable reader's failure leaves the
	 * record pending so a later state can retry. Permanent skips keep a terminal disposition and cancel any second timer.
	 */
	protected async confirmQueuedEnd(c: Candidate, live: ThreadState, runId: string): Promise<boolean> {
		const record = this.pendingHandoffs.get(c.key);
		const obs = await this.handoffObservation(live.id);
		// Re-read watcher state after the observation: a successor may have arrived during the awaits.
		const latest = this.states.get(live.id)?.latestRunId;
		const decision = confirmHandoff(obs, runId, record, latest);
		if (decision.action === "retry") {
			this.log(decision.reason, { server: this.srv.name, threadId: live.id, runId });
			return false;
		}
		if (decision.action === "skip") {
			this.log(decision.reason, { server: this.srv.name, threadId: live.id, runId });
			if (record) this.saveHandoff(c.key, { ...record, disposition: rejectedDisposition(decision.reason) });
			// A state mid-read may have scheduled another fire; that must not revive this rejection as an idle-gap.
			clearTimeout(this.timers.get(c.key));
			this.timers.delete(c.key);
			return false;
		}
		for (const id of decision.intervening) {
			const key = handoffKey(live.id, id);
			if (this.core.notified.has(key) || this.timers.has(key) || this.pendingHandoffs.has(key)) continue;
			if (record)
				this.saveHandoff(key, {
					threadId: live.id,
					runId: id,
					successorId: record.successorId,
					disposition: "pending",
				});
			this.schedule({ kind: "turn_ended", thread: live, key });
		}
		return true;
	}

	/** One coherent runs+items read when the adapter offers it; otherwise separate reads with fail-closed semantics. */
	protected async handoffObservation(threadId: string): Promise<HandoffObservation> {
		if (this.inspect?.handoffSnapshot) {
			try {
				const snap = await this.inspect.handoffSnapshot(threadId);
				return { kind: "ok", runs: snap.runs, items: snap.items };
			} catch (e) {
				return { kind: "failed", error: String(e).slice(0, 200) };
			}
		}
		if (!this.inspect?.runs) return { kind: "unsupported" };
		try {
			const runs = await this.inspect.runs(threadId);
			const items = (await this.instructionRead(threadId)).items;
			return { kind: "ok", runs, items };
		} catch (e) {
			return { kind: "failed", error: String(e).slice(0, 200) };
		}
	}

	/** Remember a LIVE→LIVE handoff so confirmation after debounce still knows the causing successor and interval. */
	protected rememberHandoff(prev: ThreadState | undefined, next: ThreadState, c: Candidate) {
		if (
			c.kind !== "turn_ended" ||
			!prev ||
			!LIVE.has(prev.status) ||
			!LIVE.has(next.status) ||
			!prev.latestRunId ||
			!next.latestRunId ||
			prev.latestRunId === next.latestRunId
		)
			return;
		// A new distinct interval drops prior terminal dispositions for this thread.
		for (const [key, h] of this.pendingHandoffs) {
			if (h.threadId === next.id && h.disposition !== "pending") this.pendingHandoffs.delete(key);
		}
		this.core.store.handoffs.clearTerminal(this.srv.name, next.id);
		this.saveHandoff(c.key, {
			threadId: next.id,
			runId: prev.latestRunId,
			successorId: next.latestRunId,
			disposition: "pending",
		});
	}

	/** Re-queue only still-pending (unconfirmed) handoffs after a later state. Rejected ones stay terminal. */
	protected retryPendingHandoffs(th: ThreadState) {
		for (const [key, h] of this.pendingHandoffs) {
			if (h.disposition !== "pending") continue;
			if (h.threadId !== th.id || this.core.notified.has(key) || this.timers.has(key)) continue;
			this.schedule({ kind: "turn_ended", thread: th, key });
		}
	}

	/** Close a pending row once its wake is claimed (or was already claimed before a restart). */
	protected markHandoffConfirmed(key: string) {
		const done = this.pendingHandoffs.get(key);
		if (done?.disposition !== "pending") return;
		this.saveHandoff(key, { ...done, disposition: "confirmed" });
	}
}
