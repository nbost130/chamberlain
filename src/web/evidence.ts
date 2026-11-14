/**
 * Evidence files come only from ~/.local/state/chamberlain/evidence/<itemId>/, and only the names the item lists. Anything that
 * climbs out of that folder, by "..", an absolute path, an encoded slash or a symlink, is refused. That includes the
 * evidence folder itself: its real path must be <real state dir>/evidence, so a symlinked evidence folder serves nothing.
 */
import { lstatSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import { evidenceRoot, ITEM_ID } from "../core/questions.ts";

export const EVIDENCE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The real path to serve, or undefined when the request must be refused. */
export function resolveEvidence(
	state: string,
	itemId: string,
	name: string,
	listed: string[],
): { path: string; type: string } | undefined {
	if (!ITEM_ID.test(itemId) || !NAME.test(name) || name.includes("..") || !listed.includes(name)) return undefined;
	const type = EVIDENCE_TYPES[extname(name).toLowerCase()];
	if (!type) return undefined;
	try {
		const root = evidenceRoot(state);
		const rootReal = realpathSync(root);
		if (rootReal !== `${realpathSync(state)}/evidence`) return undefined;
		const dir = `${root}/${itemId}`;
		if (lstatSync(dir).isSymbolicLink()) return undefined;
		const dirReal = realpathSync(dir);
		if (dirReal !== `${rootReal}/${itemId}`) return undefined;
		const file = `${dir}/${name}`;
		const st = lstatSync(file);
		if (st.isSymbolicLink() || !st.isFile()) return undefined;
		const real = realpathSync(file);
		if (!real.startsWith(`${dirReal}/`)) return undefined;
		return { path: real, type };
	} catch {
		return undefined;
	}
}
