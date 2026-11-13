/**
 * Private files in the config directory: tokens, URLs, the Steward's thread id. The rule is exact, and it fails closed:
 *   - a secret or config FILE is a regular file with mode exactly 0600 (not 0700, 0400, 0500 or 0200: "no group or other bits" is
 *     not the rule, 0600 is);
 *   - a DIRECTORY that holds them or the database is mode exactly 0700.
 * Every reader uses `isPrivateFile`, so there is one definition of "private" and not a dozen copies of a mask.
 *
 * AUTHORITY files (text the Steward follows as instructions, such as the brief fragments in `brief.d/`) are not secrets: anyone may read
 * them, so 0644 is fine. The danger is someone else WRITING them, so the rule (`authorityProblem`) is: the expected kind (never a symlink),
 * owned by this process's effective uid, and no group or world write bit.
 */
import { chmodSync, readFileSync, statSync, type Stats } from "node:fs";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** A mode as the usual four octal digits: 0600. */
export const modeText = (mode: number) => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
/** A regular file with mode exactly 0600. */
export const isPrivateFile = (st: Stats): boolean => st.isFile() && (st.mode & 0o777) === FILE_MODE;

/** The kinds of `Stats` `authorityProblem` reads (a seam for tests). */
export type AuthorityStat = Pick<Stats, "mode" | "uid" | "isFile" | "isDirectory" | "isSymbolicLink">;

/**
 * Why a file or directory that carries authority may not be trusted, or undefined when it may: it must be a regular file (or a directory,
 * for `kind` "directory") and not a symlink (the stat must come from `lstat` or an `fstat` of a descriptor opened with O_NOFOLLOW), owned by
 * the effective uid (`euid`, default this process's), and writable by neither its group nor other users. Readable by others is fine.
 */
export function authorityProblem(st: AuthorityStat, kind: "file" | "directory", euid: number | undefined = process.geteuid?.()): string | undefined {
	if (st.isSymbolicLink()) return "it is a symlink, which is never followed";
	if (kind === "file" && !st.isFile()) return "it is not a regular file";
	if (kind === "directory" && !st.isDirectory()) return "it is not a directory";
	if (euid !== undefined && st.uid !== euid) return `owned by uid ${st.uid}, not ${euid}`;
	const g = (st.mode & 0o020) !== 0, o = (st.mode & 0o002) !== 0;
	if (g || o) return `${g && o ? "group- and world-writable" : g ? "group-writable" : "world-writable"} (mode ${modeText(st.mode)}): only its owner may write it`;
	return undefined;
}

/** A file or directory is not private enough to use. The message says what it is, what it must be, and how to fix it. */
export class InsecureModeError extends Error {
	constructor(readonly path: string, readonly found: number, readonly wanted: number, what: string, cause?: string) {
		super(`${what} ${path} has mode ${modeText(found)}, not ${modeText(wanted)}${cause ? `, and changing it failed (${cause})` : ""}. Refusing to start: fix it with \`chmod ${(wanted & 0o777).toString(8)} ${path}\`.`);
		this.name = "InsecureModeError";
	}
}

/**
 * Sets a path to exactly `wanted` and CHECKS it took. A chmod that fails (not our file, a filesystem without modes) is not swallowed: the
 * mode is read back, and a path that is still not `wanted` throws InsecureModeError. `chmod` is a seam for tests.
 */
export function enforceMode(path: string, wanted: number, what: string, chmod: (p: string, m: number) => void = chmodSync): void {
	let cause: string | undefined;
	if ((statSync(path).mode & 0o777) !== wanted) { try { chmod(path, wanted); } catch (e) { cause = String((e as Error).message ?? e).slice(0, 120); } }
	const found = statSync(path).mode & 0o777;
	if (found !== wanted) throw new InsecureModeError(path, found, wanted, what, cause);
}

/** An existing config or state directory must be a directory with mode exactly 0700. A missing one is not an error here. */
export function assertPrivateDir(path: string, what: string): void {
	let st: Stats;
	try { st = statSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
	if (!st.isDirectory()) throw Error(`${what} ${path} is not a directory`);
	if ((st.mode & 0o777) !== DIR_MODE) throw new InsecureModeError(path, st.mode, DIR_MODE, what);
}

/**
 * The trimmed contents of `<conf>/<name>`, or undefined when the file is missing or empty. A file that is not a private
 * regular file (mode exactly 0600) throws: a token or a URL that anyone can read is refused, not used.
 */
export function privateFile(conf: string, name: string): string | undefined {
	try {
		const p = `${conf}/${name}`;
		const st = statSync(p);
		if (!isPrivateFile(st)) throw Error(`${name} must be a private regular file with mode exactly 0600 (it is ${modeText(st.mode)})`);
		return readFileSync(p, "utf8").trim() || undefined;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}
