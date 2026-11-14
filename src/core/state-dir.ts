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
function resolve(env: Env, override: string, xdg: string, fallback: string, home: string): string {
	if (usable(env[override])) return env[override]!;
	if (usable(env[xdg])) return `${env[xdg]!.replace(/\/+$/, "")}/chamberlain`;
	return `${home}/${fallback}/chamberlain`;
}

export const configDir = (env: Env, home: string) => resolve(env, "CHAMBERLAIN_CONF", "XDG_CONFIG_HOME", ".config", home);
export const stateDir = (env: Env, home: string) => resolve(env, "CHAMBERLAIN_STATE", "XDG_STATE_HOME", ".local/state", home);
