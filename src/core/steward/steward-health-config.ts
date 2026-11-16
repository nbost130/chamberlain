/** The Steward health thresholds. */

export const HEALTH_CONFIG = {
	context: 200_000, // Watch threshold, well below the compaction threshold.
	compactContext: 350_000, // The Steward is one permanent thread that compacts past 350k; the daemon's compact threshold defaults to this too.
	replies: 20, // Recent behavior, rather than lifetime mistakes.
	formatBreaks: 3, // Three slips in the recent window filters isolated mistakes.
	selfReads: 3, // Repeated reconstruction is a warning; one lookup is ordinary work.
	threadRereads: 4, // Several repeated lookups before treating normal checking as wear.
	windowMs: 10 * 60_000, // Same-thread reads within ten minutes are a repeat.
	intervalMs: 60 * 60_000, // Hourly, as requested.
};
