/** A promise that gives up after a deadline, so one hung call can't stall a poll. The timer is always cleared. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(Error(`${what} timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
