import { readFileSync } from "node:fs";
import { segmentTranscript } from "../core/steward/steward-segments.ts";

// A synthetic transcript: every kind of turn-starting prompt, the rows that are not prompts, a request written as two rows, a sidechain,
// a synthetic reply, a compaction and a repeated delivery id. Its thread text carries markers that must never reach a report.
export const session = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export const fixtureText = readFileSync(
	new URL("../core/fixtures/steward-tokens.jsonl", import.meta.url),
	"utf8",
).replaceAll("{{SESSION}}", session);

const fixture = fixtureText.trim().split("\n");

export const segments = () => segmentTranscript(fixture, session);

export const byKey = async (key: string) => (await segments()).find((s) => s.wakeKey === key)!;
