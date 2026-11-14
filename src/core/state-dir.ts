/**
 * Where Chamberlain's directories are, by the XDG Base Directory Specification
 * (https://specifications.freedesktop.org/basedir/latest/):
 *
 *   config   $CHAMBERLAIN_CONF, else $XDG_CONFIG_HOME/chamberlain, else ~/.config/chamberlain
 *   state    $CHAMBERLAIN_STATE, else $XDG_STATE_HOME/chamberlain, else ~/.local/state/chamberlain
 *
 * State is "state data that should persist between restarts": the database (rulings and the decision log are in it), the
 * evidence files its rows point to, and the hand-off. It is not a cache: nothing here may be wiped by the OS or a cleanup tool.
 * A real cache would go under $XDG_CACHE_HOME/chamberlain; Chamberlain keeps none today.
 *
 * The specification says a variable holding a relative path is invalid and must be ignored, and so does an empty one.
 */
import { isAbsolute } from "node:path";

type Env = Record<string, string | undefined>;

/** An environment value that may name a directory: set, non-empty and absolute (the XDG rule). */
const usable = (v: string | undefined): v is string => v !== undefined && v !== "" && isAbsolute(v);

/** Pure: the directory a Chamberlain override variable or an XDG base variable names, with the default under `home`. */
/** The variables and default one directory comes from: its own override, the XDG base, and the home-relative fallback. */
type DirNames = { override: string; xdg: string; fallback: string };

function resolve(env: Env, { override, xdg, fallback }: DirNames, home: string): string {
	const own = env[override];
	if (usable(own)) return own;
	const base = env[xdg];
	if (usable(base)) return `${base.replace(/\/+$/, "")}/chamberlain`;
	return `${home}/${fallback}/chamberlain`;
}

export const configDir = (env: Env, home: string) =>
	resolve(env, { override: "CHAMBERLAIN_CONF", xdg: "XDG_CONFIG_HOME", fallback: ".config" }, home);
export const stateDir = (env: Env, home: string) =>
	resolve(env, { override: "CHAMBERLAIN_STATE", xdg: "XDG_STATE_HOME", fallback: ".local/state" }, home);
