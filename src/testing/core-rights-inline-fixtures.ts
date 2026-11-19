import { RIGHTS_SENT_KEY, rightsEpoch } from "../core/steward/rights-sent.ts";
import type { useCoreRelayFixtures } from "./core-relay-fixtures.ts";
import { memStore } from "./store.ts";

type Fixtures = ReturnType<typeof useCoreRelayFixtures>;

/**
 * One Steward whose rights, session, size and compaction count the test moves; the full stamp carries the epoch it is composed under, as the
 * engine's does. Built over a test file's own relay fixtures (`useCoreRelayFixtures(createRelay)`).
 */
export function inlineWorldOf({ rig, H1, stamp, BLOCK }: Fixtures) {
	return function inlineWorld(o: { inline?: boolean; block?: string } = {}) {
		const store = memStore();
		const st: {
			steward: string;
			session: string;
			hash?: string;
			used?: number;
			compactions?: number;
			/** The read of the rights throws (a transcript or database that cannot be read). */
			broken?: true;
		} = {
			steward: "steward-1",
			session: "s1",
			hash: H1,
			used: 100_000,
			compactions: 4,
		};
		const rightsNow = async () => {
			if (st.broken) throw new Error("transcript unreadable");
			const { broken: _broken, ...now } = st;
			return {
				...now,
				wake: (forId: string) => ({
					message: `[chamberlain] rights for ${forId}\n${BLOCK}`,
					text: st.hash === undefined ? "the rights cannot be read" : `${o.block ?? BLOCK} (${st.hash.slice(0, 4)})`,
					...(st.hash === undefined
						? {}
						: {
								stamp: {
									steward: st.steward,
									session: st.session,
									hash: st.hash,
									at: "now",
									...(st.used !== undefined ? { used: st.used } : {}),
									...(st.compactions !== undefined ? { compactions: st.compactions } : {}),
									full: true as const,
									epoch: rightsEpoch(store),
								},
							}),
				}),
			};
		};
		const r = rig({ store, rightsNow, rightsInline: o.inline ?? true });
		const record = () => store.state.get(RIGHTS_SENT_KEY) as Record<string, unknown> | undefined;
		const pointer = (id: string) => r.outbox.deliver(`text of ${id}`, id, { kind: "needs_input", rights: [stamp] });
		const rightsRows = () => store.wakes.rows("all").filter((w) => w.kind === "rights");
		return { ...r, st, record, pointer, rightsRows };
	};
}
