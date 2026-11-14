/**
 * The memory behind `log.change(key, state)`: what state a key was last seen in and how many repeats of it were suppressed since.
 * `session-error` used to write one row per retry (7,904 rows for one unreachable server); now it writes one per outage.
 */
export type Step = { write: boolean; suppressed: number };

export class Transitions {
	private readonly states = new Map<string, { state: string; suppressed: number }>();

	/** A sighting of `state`. A repeat is suppressed and counted; a first sighting or a change is written, with the count the old state suppressed. */
	see(key: string, state: string): Step {
		const cur = this.states.get(key);
		if (cur?.state === state) {
			cur.suppressed++;
			return { write: false, suppressed: 0 };
		}
		this.states.set(key, { state, suppressed: 0 });
		return { write: true, suppressed: cur?.suppressed ?? 0 };
	}

	/** A sighting that is only worth a row when it ends a state recorded earlier (a connect after an outage): a first one just sets the state. */
	recover(key: string, state: string): Step {
		return this.states.has(key) ? this.see(key, state) : this.set(key, state);
	}

	private set(key: string, state: string): Step {
		this.states.set(key, { state, suppressed: 0 });
		return { write: false, suppressed: 0 };
	}
}
