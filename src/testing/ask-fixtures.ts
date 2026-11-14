import { expect } from "bun:test";
import { parseAsk } from "../ask-parse.ts";

export const base = {
	kind: "ruling",
	title: "Pick",
	context: "- a",
	options: ["A", "B"],
	thread: "t",
	server: "main",
	proposedRuling: "Do it this way for this launch.",
};

export const NOW = new Date().toISOString();

export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export const ID = "Q-abc12";

export const mk = (o: Record<string, unknown>) => parseAsk({ ...base, ...o }, ID, NOW);

export const refuses = (o: Record<string, unknown>, text: string | RegExp) => expect(() => mk(o)).toThrow(text);
