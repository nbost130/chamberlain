/** The engine's core, second layer: the decision rights and rulings a wake carries. */
import { has } from "../adapter/adapter-conformance.ts";
import { type RightsSent, rightsUnreadable } from "../decide/decide.ts";
import { alarms } from "../messages.ts";
import { readRulings } from "../ops/rulings.ts";
import { renderInForce } from "../ops/rulings-read.ts";
import { epochOf, fullStamp, rightsFirstMessage, rightsFor, rightsHash } from "../steward/rights-sent.ts";
import { CoreBase } from "./engine-core.ts";

export abstract class CoreRights extends CoreBase {
	/**
	 * The rights a wake carries. The full text goes after anything that could have cost the Steward its copy, and doubt sends it again: the
	 * durable record (rights-sent.ts, written by the relay when a full block is delivered) must name this Steward thread and session. The away
	 * mandate is state, so it goes every time. `forcePointer` keeps the one-line pointer and pointer stamp even when a full block would
	 * otherwise go (holdable turn_ended); rights-first still fills a gap before send.
	 */
	wakeRights(
		mandate: string,
		o: { full?: boolean; forcePointer?: boolean; session?: string | undefined; steward?: string } = {},
	): { text: string; record?: RightsSent; full?: boolean } {
		const rules = this.rightsRules();
		if (rules === undefined) {
			this.raiseAlarm("rights-unreadable", alarms.rightsUnreadable());
			return { text: [rightsUnreadable(), mandate].filter(Boolean).join("\n") };
		}
		// One Steward identity: snapshot (when supplied), else MAX(gen), else mirrored config (R1).
		const id = o.steward ?? this.store.steward.current()?.thread ?? this.privateFile("steward-thread");
		// The epoch this wake is composed under, read with the record: its full stamp writes the record only while that epoch is current.
		const sent = this.rightsSent.get(),
			epoch = this.rightsSent.epoch();
		const held =
			!o.full && sent && sent.steward === id && sent.session === o.session && epochOf(sent) === epoch
				? sent
				: undefined;
		return rightsFor(held, {
			stewardId: id,
			rules,
			mandate,
			used: id ? this.probe()?.contextTokens : undefined,
			now: new Date().toISOString(),
			epoch,
			...(o.forcePointer ? { forcePointer: true } : {}),
		});
	}

	/** The decision rights and the in-force rulings, as one text, or undefined when either cannot be read. */
	protected rightsRules(): string | undefined {
		const [rights, rulings] = [this.privateFile("decision-rights.md"), this.stewardRulings()];
		return rights && rulings ? `${rights}\n${rulings}` : undefined;
	}

	/** The Steward's current session, when the adapter can say (`transcriptPath`). Undefined when it cannot, or the read fails. */
	async stewardSession(): Promise<string | undefined> {
		if (!has(this.homeAdapter, "transcriptPath")) return undefined;
		try {
			return (await this.homeAdapter.transcriptPath()).session;
		} catch {
			return undefined;
		}
	}

	/**
	 * Rights identity is one Steward thread from the generation snapshot (or MAX(gen)), never a stale mirror alone (R1).
	 * The same identity hashes the decision and composes the full prerequisite.
	 */
	protected async rightsNow(o?: { steward?: string }) {
		const steward = o?.steward ?? this.store.steward.current()?.thread ?? this.privateFile("steward-thread"),
			session = await this.stewardSession(),
			rules = this.rightsRules();
		const hash = rules === undefined ? undefined : rightsHash(steward, rules);
		return {
			...(steward ? { steward } : {}),
			...(session ? { session } : {}),
			...(hash ? { hash } : {}),
			wake: (forId: string) => {
				const full = this.wakeRights("", { full: true, session, ...(steward ? { steward } : {}) });
				return {
					message: rightsFirstMessage(forId, full.text),
					...(full.record ? { stamp: fullStamp(full.record, steward, session) } : {}),
				};
			},
		};
	}

	/** The rulings a wake carries: the in-force ones with their IDs. */
	protected stewardRulings(): string | undefined {
		try {
			return renderInForce(readRulings(this.store)) || "None in force.";
		} catch (e) {
			this.log("rulings-unreadable", { error: String(e).slice(0, 200) });
			return undefined;
		}
	}
}
