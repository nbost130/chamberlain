/** `chamberlain triage …` / `bun src/triage.ts …`. */
import { main as run } from "./core/desk/alert-triage-cli.ts";

export function main(argv: string[]): number {
	return run(argv);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
