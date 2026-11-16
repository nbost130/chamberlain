import type { RuleSpec } from "../core/ops/rules.ts";

export const source = `# Operating rules

## Secrets
- Never paste or echo a secret.
- Enter secrets only in their own thread.

## Working style
- Whole issue: finish a piece before starting the next.
- Smallest change that works.
- Builder-only note nobody else needs.

## Builders
- Use the fast lane for builds.
`;

export const spec: RuleSpec[] = [
	["Secrets", "whole"],
	["Working style", ["- Whole issue", "- Smallest change"]],
];

export const host = `# This host

## Deltas
Where this host differs from the shared rules.

| Rule | Here |
|---|---|
| \`timeout\` | Use the GNU one. |
| Shell idioms | zsh, not bash. |
| Builder-only row | Nobody else needs it. |

## Other
- Not wanted.
`;
