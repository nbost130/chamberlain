/**
 * Legacy alias: `chamberlain switch-steward <threadId> --live`.
 * Requires --live (M4). Prefer `chamberlain steward prepare` + `steward switch`.
 */
import { main as stewardMain } from "../../core/steward-switch.ts";

export function main(argv: string[] = process.argv.slice(2)) {
	if (!argv.includes("--live")) {
		console.error("switch-steward requires --live (use: chamberlain steward prepare <thread> --live)");
		process.exit(2);
	}
	const threadId = argv.find((a) => !a.startsWith("-"));
	if (!threadId) {
		console.error("usage: switch-steward.ts <threadId> --live");
		process.exit(2);
	}
	// Alias maps to prepare of the new protocol (successor still writes switch-owned refs, then steward switch).
	process.exitCode = stewardMain(["prepare", threadId, "--live"]);
}

if (import.meta.main) main();
