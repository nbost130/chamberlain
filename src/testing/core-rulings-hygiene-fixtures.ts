import type { Clock } from "../core/ops/rulings.ts";

export const at =
	(iso: string): Clock =>
	() =>
		Date.parse(iso);

export const NOW = at("2026-11-13T12:00:00Z");
