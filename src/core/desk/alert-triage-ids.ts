/** Opaque digest ids for alert-triage obligations, occurrences and attempts. */
import { createHash } from "node:crypto";

export const ID_RE = /^(a[ko]_[0-9a-f]{20}|triage:[0-9a-f]{20}:\d{1,4})$/;
export const OCC_RE = /^ao_[0-9a-f]{20}$/;

const hex = (parts: unknown[], n: number) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, n);

export const alertKey = (source: string, family: string): string =>
	`ak_${hex(["chamberlain-alert-v1", source, family], 20)}`;

export const occRef = (key: string, seq: number): string => `ao_${hex(["occ", key, seq], 20)}`;

export const attemptId = (occ: string, ordinal: number): string => {
	const h = occ.startsWith("ao_") ? occ.slice(3) : occ;
	return `triage:${h}:${ordinal}`;
};

export const seqKey = (ak: string) => `seq:${ak}`;
export const obKey = (ak: string) => `ob:${ak}`;
