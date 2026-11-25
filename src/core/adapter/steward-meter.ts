import type { WakeUsage } from "../store/store-records.ts";

/** Adapter observations contain no tool arguments or prompt text. */
export type StewardQuality = {
	threadRereads?: number;
	selfReads?: number;
	boundary?: string;
	unknown?: string;
};

export type StewardMeterRead = { unknown: string } | { rows: WakeUsage[]; quality?: StewardQuality; partial?: string };
