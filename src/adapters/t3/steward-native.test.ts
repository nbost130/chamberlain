import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPLETED, provider, t3Db, turn } from "../../testing/t3-context-fixture.ts";
import { t3Probe } from "./steward.ts";

const CONVERSATION = "01234567-89ab-4cde-8fab-0123456789ab";
const INSTANCE = "fixture-provider";

function varint(n: number): number[] {
	const result: number[] = [];
	while (n >= 128) {
		result.push((n % 128) | 128);
		n = Math.floor(n / 128);
	}
	return [...result, n];
}

function field(id: number, value: number | number[]): number[] {
	return typeof value === "number"
		? [...varint(id * 8), ...varint(value)]
		: [...varint(id * 8 + 2), ...varint(value.length), ...value];
}

function metadata({ tokens = 410_000, window = 480_000, input = 350_000, cached = [0] as number[] } = {}) {
	return new Uint8Array(
		field(1, [
			...field(4, [...field(2, input), ...cached]),
			...field(9, field(10, [...field(1, tokens), ...field(4, window)])),
		]),
	);
}

function nativeFixture(nativeId = `${CONVERSATION}:turn:1`, instance = INSTANCE) {
	const path = t3Db();
	const base = dirname(path);
	const profile = createHash("sha256").update(INSTANCE).digest("hex");
	const nativePath = join(
		base,
		"userdata",
		"providers",
		"antigravity",
		profile,
		"antigravity-acp",
		"conversations",
		`${CONVERSATION}.db`,
	);
	mkdirSync(dirname(nativePath), { recursive: true });
	const db = new Database(path);
	db.run("delete from orchestration_v2_projection_provider_threads");
	provider(db, "primary", "antigravity", { providerInstanceId: instance, nativeThreadRef: { nativeId: CONVERSATION } });
	turn(db, "primary", 1, {
		payload: { nativeTurnRef: { driver: "antigravity", nativeId }, turnTokenUsage: { inputTokens: 900_000 } },
	});
	db.close();
	const native = new Database(nativePath);
	native.run("pragma journal_mode = wal");
	native.run("create table gen_metadata (idx integer primary key, data blob, size integer)");
	const add = (idx: number, data: Uint8Array) =>
		native.run("insert into gen_metadata values (?, ?, ?)", [idx, data, data.length]);
	return { native, nativePath, add, probe: () => t3Probe(path, "th", Date.now(), { base }) };
}

test("the native reader reads the newest request in WAL and accepts a real shrink", () => {
	const fixture = nativeFixture();
	try {
		fixture.add(1, metadata({ cached: field(5, 50_000) }));
		expect(fixture.probe().context).toEqual({
			beforeTurnEffects: true,
			tokens: 410_000,
			window: 480_000,
			at: COMPLETED,
			source: "native request",
		});
		fixture.add(2, metadata({ tokens: 68_000, input: 60_000, cached: field(5, 5000) }));
		expect(fixture.probe().contextTokens).toBe(68_000);
	} finally {
		fixture.native.close();
	}
});

test("a request with no cached input is read: an absent count is zero, and the size check still applies", () => {
	const fixture = nativeFixture();
	try {
		fixture.add(1, metadata({ input: 400_000, cached: [] }));
		expect(fixture.probe().contextTokens).toBe(410_000);
		fixture.add(2, metadata({ input: 100_000, cached: [] }));
		expect(fixture.probe().context).toMatchObject({ unknown: expect.any(String) });
	} finally {
		fixture.native.close();
	}
});

test("a newest row that carries a multi-megabyte prompt is read, whichever side of the numbers the prompt is on", () => {
	const fixture = nativeFixture();
	const numbers = metadata({ cached: field(5, 50_000) });
	const prompt = new Uint8Array([...varint(2 * 8 + 2), ...varint(3_000_000)]);
	const body = new Uint8Array(3_000_000).fill(255);
	try {
		fixture.add(1, Buffer.concat([prompt, body, numbers]));
		expect(fixture.probe().contextTokens).toBe(410_000);
		fixture.add(2, Buffer.concat([numbers, prompt, body]));
		expect(fixture.probe().contextTokens).toBe(410_000);
	} finally {
		fixture.native.close();
	}
});

test("a new conversation, whose fixed part is not counted as input, is still read", () => {
	const fixture = nativeFixture();
	try {
		fixture.add(1, metadata({ tokens: 44_000, input: 33_000, cached: [] }));
		expect(fixture.probe().contextTokens).toBe(44_000);
	} finally {
		fixture.native.close();
	}
});

test.each([
	["no input", new Uint8Array(field(1, field(9, field(10, [...field(1, 410_000), ...field(4, 480_000)]))))],
	["no size", new Uint8Array(field(1, field(4, field(2, 410_000))))],
	["wrong wire type", metadata({ cached: field(5, [0]) })],
	["disagreement", metadata({ input: 20_000, cached: field(5, 50_000) })],
	["over window", metadata({ window: 400_000, cached: field(5, 50_000) })],
	["truncated record", metadata({ cached: field(5, 50_000) }).slice(0, -1)],
])("invalid latest native record (%s) gives unknown even with an older valid record", (_, data) => {
	const fixture = nativeFixture();
	try {
		fixture.add(1, metadata({ cached: field(5, 50_000) }));
		fixture.add(2, data);
		expect(fixture.probe().context).toMatchObject({ unknown: expect.any(String) });
	} finally {
		fixture.native.close();
	}
});

test.each([
	[`${CONVERSATION}:turn:0`, INSTANCE],
	["76543210-89ab-4cde-8fab-0123456789ab:turn:1", INSTANCE],
	[`${CONVERSATION}:turn:1`, "other-provider"],
])("the native turn and profile must match the active provider", (id, instance) => {
	const fixture = nativeFixture(id, instance);
	try {
		fixture.add(1, metadata({ cached: field(5, 50_000) }));
		expect(fixture.probe().context).toMatchObject({ unknown: expect.any(String) });
	} finally {
		fixture.native.close();
	}
});

test("a native database last written before the newest turn cannot supply its size", () => {
	const fixture = nativeFixture();
	fixture.add(1, metadata({ cached: field(5, 50_000) }));
	fixture.native.close();
	utimesSync(fixture.nativePath, 1000, 1000);
	expect(fixture.probe().context).toMatchObject({ unknown: expect.any(String) });
});

test("an unreadable native table leaves the completed turn explicitly unknown", () => {
	const fixture = nativeFixture();
	try {
		fixture.add(1, metadata({ cached: field(5, 50_000) }));
		expect(fixture.probe().contextTokens).toBe(410_000);
		fixture.native.run("drop table gen_metadata");
		expect(fixture.probe()).toMatchObject({
			completedTurn: 1,
			unknownTurns: [1],
			context: { unknown: expect.any(String) },
		});
	} finally {
		fixture.native.close();
	}
});
