import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

const CONVERSATION = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const MAX_METADATA_BYTES = 1024 * 1024;
const INPUT_MARGIN = 0.25;

class Wire {
	private offset = 0;

	constructor(private readonly bytes: Uint8Array) {}

	varint(): bigint {
		let value = 0n;
		for (let i = 0; i < 10; i++) {
			const byte = this.bytes[this.offset++];
			if (byte === undefined || (i === 9 && byte > 1)) throw Error("invalid varint");
			value |= BigInt(byte & 127) << BigInt(i * 7);
			if (byte < 128) return value;
		}
		throw Error("invalid varint");
	}

	slice(length: number): Uint8Array {
		const start = this.offset;
		this.offset += length;
		if (this.offset > this.bytes.length) throw Error("invalid field size");
		return this.bytes.subarray(start, this.offset);
	}

	skipVarint() {
		for (let i = 0; i < 10; i++) {
			const byte = this.bytes[this.offset++];
			if (byte === undefined || (i === 9 && byte > 1)) throw Error("invalid varint");
			if (byte < 128) return;
		}
		throw Error("invalid varint");
	}

	get more() {
		return this.offset < this.bytes.length;
	}
}

function skip(wire: Wire, type: number) {
	if (type === 0) wire.skipVarint();
	else if (type === 1) wire.slice(8);
	else if (type === 2) wire.slice(Number(wire.varint()));
	else if (type === 5) wire.slice(4);
	else throw Error("unexpected wire type");
}

/** Follow just one numeric path. Unrelated values are skipped without decoding their contents. */
function field(bytes: Uint8Array, path: readonly number[]): number {
	const wire = new Wire(bytes);
	const [wanted, ...rest] = path;
	let result: number | undefined;
	while (wire.more) {
		const tag = wire.varint();
		const type = Number(tag & 7n);
		const number = Number(tag >> 3n);
		if (number < 1 || number > 0x1fffffff) throw Error("invalid field tag");
		if (number !== wanted) {
			skip(wire, type);
			continue;
		}
		if (result !== undefined) throw Error("duplicate field");
		result = numericValue(wire, type, rest);
	}
	if (result === undefined || !Number.isSafeInteger(result)) throw Error("numeric field unavailable");
	return result;
}

function numericValue(wire: Wire, type: number, path: readonly number[]): number {
	if (type !== (path.length ? 2 : 0)) throw Error("unexpected wire type");
	return path.length ? field(wire.slice(Number(wire.varint())), path) : Number(wire.varint());
}

function conversationDb(base: string, instance: string, conversation: string): string | undefined {
	if (!base || !CONVERSATION.test(conversation)) return undefined;
	const profile = createHash("sha256").update(instance).digest("hex");
	const path = join(
		realpathSync(base),
		"userdata",
		"providers",
		"antigravity",
		profile,
		"antigravity-acp",
		"conversations",
		`${conversation}.db`,
	);
	return realpathSync(path) === path && lstatSync(path).isFile() ? path : undefined;
}

function measure(data: Uint8Array) {
	const tokens = field(data, [1, 9, 10, 1]);
	const window = field(data, [1, 9, 10, 4]);
	const input = field(data, [1, 4, 2]) + field(data, [1, 4, 5]);
	if (tokens <= 0 || tokens > window || Math.abs(input - tokens) > tokens * INPUT_MARGIN) return undefined;
	return { tokens, window };
}

/** Read only the newest request's four numeric fields. A locked or changed database has no observation. */
export function nativeContext(base: string, instance: string, conversation: string, since: number) {
	try {
		const path = conversationDb(base, instance, conversation);
		if (!path || !Number.isFinite(since) || lastWrite(path) < since) return undefined;
		const db = new Database(path, { readonly: true });
		try {
			const row = db
				.query("select case when length(data) <= ? then data end as data from gen_metadata order by idx desc limit 1")
				.get(MAX_METADATA_BYTES) as { data: unknown } | null;
			return row?.data instanceof Uint8Array ? measure(row.data) : undefined;
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

function lastWrite(path: string): number {
	const wal = lstatSync(`${path}-wal`, { throwIfNoEntry: false });
	if (wal && !wal.isFile()) throw Error("invalid database journal");
	return Math.max(lstatSync(path).mtimeMs, wal?.mtimeMs ?? 0);
}
