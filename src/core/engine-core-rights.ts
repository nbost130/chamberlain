/** The engine's core, second layer: the decision rights and rulings a wake carries. */
import { has } from "./adapter-conformance.ts";
import { type RightsSent, rightsUnreadable } from "./decide.ts";
import { CoreBase } from "./engine-core.ts";
import { alarms } from "./messages.ts";
import { epochOf, fullStamp, rightsFirstMessage, rightsFor, rightsHash } from "./rights-sent.ts";
import { readRulings } from "./rulings.ts";
import { renderInForce } from "./rulings-read.ts";

export abstract class CoreRights extends CoreBase {
	/**
	 * The rights a wake carries. The full text goes after anything that could have cost the Steward its copy, and doubt sends it again: the
	 * durable record (rights-sent.ts, written by the relay when a full block is delivered) must name this Steward thread and session. The away
	 * mandate is state, so it goes every time.
	 */
	wakeRights(
		mandate: string,
		o: { full?: boolean; session?: string | undefined } = {},
	): { text: string; record?: RightsSent; full?: boolean } {
		const rules = this.rightsRules();
		if (rules === undefined) {
			this.raiseAlarm("rights-unreadable", alarms.rightsUnreadable());
			return { text: [rightsUnreadable(), mandate].filter(Boolean).join("\n") };
		}
		const id = this.privateFile("steward-thread");
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
	 * The Steward and the rights in force now, for the relay's check before every attempt of a row that depends on the Steward holding them
	 * (relay.ts, `rightsNow`), and the standalone prerequisite for that state: the full block (or the unreadable notice), stamped `full` with the
	 * state it was composed for, so its delivery writes the durable record. The row it goes ahead of follows exactly as it was queued.
	 */
	protected async rightsNow() {
		const steward = this.privateFile("steward-thread"),
			session = await this.stewardSession(),
			rules = this.rightsRules();
		const hash = rules === undefined ? undefined : rightsHash(steward, rules);
		return {
			...(steward ? { steward } : {}),
			...(session ? { session } : {}),
			...(hash ? { hash } : {}),
			wake: (forId: string) => {
				const full = this.wakeRights("", { full: true, session });
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
