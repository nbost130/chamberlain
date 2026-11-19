/**
 * What the tick needs from whatever starts the investigator thread, as types, so src/core/overhead/ never talks to T3 itself (the T3 adapter,
 * src/adapters/t3/investigator.ts, is the one implementation).
 *
 * The contract is built for a launch whose outcome can be lost: the ids of the thread and of its brief come from `seed` (the investigation's id),
 * so a repeat of a launch is a repeat of the same commands, and `inspect` can ask T3 what a seed became.
 */

/** Where an investigator's thread stands in T3, by the seed it was launched with. */
export type ThreadState =
	| { exists: false }
	| {
			exists: true;
			threadId: string;
			/** The brief's message is in the thread: the launch completed. */
			briefSent: boolean;
			/** A run is going, queued or waiting: someone is working in it. */
			active: boolean;
			archived: boolean;
	  };

export type Investigator = {
	/**
	 * Creates the thread for `seed` if it does not exist, and sends the brief unless it is already there; repeating it is safe. Rejects with
	 * LaunchRefused when nothing was sent, and with any other error when the outcome is unknown (the request may have been accepted).
	 */
	launch(a: { seed: string; title: string; brief: string }): Promise<{ threadId: string }>;
	/** What T3 holds for `seed`. Rejects when T3 cannot say. */
	inspect(seed: string): Promise<ThreadState>;
};

/** A launch that sent nothing: the selection, the server or the connection was refused before any command went out. The only failure that releases a reservation. */
export class LaunchRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LaunchRefused";
	}
}
