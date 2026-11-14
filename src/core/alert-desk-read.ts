/** Reading the inbox file in bounded chunks of whole lines. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_READ = 4 * 1024 * 1024;
/** What an oversized chunk (4 MiB with no newline in it) becomes: a line that is never an event, so it is counted as bad and skipped. */
const OVERSIZED = "\u0000oversized";
/** Up to `len` bytes of `fd` from `start`, fewer if the file ends first. */
function readChunk(fd: number, start: number, len: number): Buffer {
	const buf = Buffer.alloc(len);
	let got = 0;
	while (got < len) {
		const n = readSync(fd, buf, got, len - got, start + got);
		if (n <= 0) break;
		got += n;
	}
	return buf.subarray(0, got);
}

/** True when the byte before `start` is not a newline: the cursor sits inside a line that was already counted as bad. */
function startsMidLine(fd: number, start: number, got: number): boolean {
	if (start <= 0 || got <= 0) return false;
	const prev = Buffer.alloc(1);
	return readSync(fd, prev, 0, 1, start - 1) === 1 && prev[0] !== 10;
}

/** The whole lines of `body` (which begins at file offset `base`) and the offset after the last one consumed; see readLines for the two tails. */
function wholeLines(
	body: Buffer,
	base: number,
	o: { start: number; got: number; skip: number; final: boolean; atEof: boolean },
): { lines: string[]; end: number } {
	const cut = body.lastIndexOf(10);
	let end = base + (cut < 0 ? 0 : cut + 1);
	const lines =
		cut < 0
			? []
			: body
					.subarray(0, cut + 1)
					.toString("utf8")
					.split("\n")
					.filter(Boolean);
	if (cut < 0 && o.skip === 0 && o.got >= MAX_READ) {
		lines.push(OVERSIZED);
		end = o.start + o.got;
	} else if (o.final && o.atEof && end < o.start + o.got) {
		lines.push(body.subarray(end - base).toString("utf8"));
		end = o.start + o.got;
	}
	return { lines, end };
}

/**
 * Reads whole lines of `path` from `from`, at most MAX_READ bytes. `end` is the offset after the last byte consumed, so a caller that saves
 * `end` has recorded exactly what it read. A torn tail is left for the next pass, unless `final` (a retired file no writer holds any more) and
 * the chunk reached the end of the file: then the tail is the file's last line. A chunk with no newline in all of MAX_READ bytes is skipped,
 * and so is the rest of that line: a cursor that does not sit just after a newline is inside a line already counted as bad, so everything up
 * to and including its newline is consumed without being read as an event.
 */
export function readLines(
	path: string,
	from: number,
	final = false,
): { lines: string[]; end: number; size: number; inode: number } | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const st = fstatSync(fd);
		const start = st.size < from ? 0 : from;
		const chunk = readChunk(fd, start, Math.min(MAX_READ, st.size - start));
		const got = chunk.length;
		const atEof = start + got >= st.size;
		let skip = 0;
		if (startsMidLine(fd, start, got)) {
			const nl = chunk.indexOf(10);
			if (nl < 0) {
				// Still inside the skipped line: a full chunk (or a retired file's last bytes) is consumed; a partial one waits for its newline.
				const consumed = got >= MAX_READ || (final && atEof);
				return { lines: [], end: consumed ? start + got : start, size: st.size, inode: st.ino };
			}
			skip = nl + 1;
		}
		const { lines, end } = wholeLines(chunk.subarray(skip), start + skip, { start, got, skip, final, atEof });
		return { lines, end, size: st.size, inode: st.ino };
	} finally {
		closeSync(fd);
	}
}
