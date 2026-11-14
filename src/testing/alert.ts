/** An alert emitter for a test: records the call and runs nothing, so no test can reach the operator's real alert command (`EngineDeps.alert`). */
export const noAlert = (_cmd: string, _args: string[], _env: NodeJS.ProcessEnv): void => {};
