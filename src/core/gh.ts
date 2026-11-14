/**
 * The GitHub reader the held-ledger reconciler uses (src/core/hold-reconcile.ts): the GitHub CLI's `api` command with a
 * `--jq` filter, parsed. The command is `gh` unless `gh` (CHAMBERLAIN_GH, or config.json) names another (a wrapper, or a stub in tests). Any
 * failure rejects, and the reconciler leaves the hold open on a rejection.
 */
import { execFile } from "node:child_process";
import type { GhRead } from "./hold-lookup.ts";
import { setting } from "./layout.ts";

export const ghRead: GhRead = (path, jq) =>
	new Promise((resolve, reject) => {
		execFile(
			setting("gh") ?? "gh",
			["api", path, "--jq", jq],
			{ timeout: 30_000, maxBuffer: 1 << 20 },
			(err, stdout, stderr) => {
				if (err)
					return reject(
						Error(`GitHub read failed: ${(stderr || err.message).toString().replace(/\s+/g, " ").slice(0, 160)}`),
					);
				try {
					resolve(JSON.parse(stdout));
				} catch {
					reject(Error(`GitHub read gave no JSON: ${stdout.slice(0, 80)}`));
				}
			},
		);
	});
