/**
 * The run-time gate on the test-only helpers (`testRelay`, `testRelayLock`, and the stub-lock handle behind them). They build a relay over a
 * stubbed kernel lock, which in production would be a relay that checks nothing, so they refuse to run unless the process says it is a test:
 * `NODE_ENV` or `BUN_ENV` is `test` (`bun test` sets `NODE_ENV=test`), or `CHAMBERLAIN_TEST_ONLY` is `1`. The architecture tests keep
 * production code from importing src/testing/; this gate is what holds when one gets in anyway.
 */
export const TEST_ONLY_FLAG = "CHAMBERLAIN_TEST_ONLY";

/** True when the environment says this process is a test run. */
export const inTestEnv = (env: Record<string, string | undefined> = process.env): boolean =>
	env.NODE_ENV === "test" || env.BUN_ENV === "test" || env[TEST_ONLY_FLAG] === "1";

/** Throws unless this is a test run. `what` names the helper that was called. */
export function requireTestEnv(what: string, env: Record<string, string | undefined> = process.env): void {
	if (!inTestEnv(env))
		throw new Error(
			`${what} is test-only and refuses to run outside a test (it builds a relay over a stubbed lock). NODE_ENV or BUN_ENV must be "test", or ${TEST_ONLY_FLAG}=1.`,
		);
}
