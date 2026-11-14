/** The page's configuration as its entry and its link commands read it: the hosts it accepts, where it listens, and loading it or exiting. */
import { CONF } from "../core/config.ts";
import { loadConfig, type WebConfig } from "./config.ts";

/** The Host header values the page accepts: its bind address and every allowed host name, bare and with the port. Anything else gets 421. */
export function acceptedHosts(cfg: { host: string; port: number; allowedHosts?: string[] }): string[] {
	return [hostPortOf(cfg), ...(cfg.allowedHosts ?? []).flatMap((h) => [h, `${h}:${cfg.port}`])];
}
/** Pure: the page's bind address with its port, an IPv6 address in brackets. */
export const hostPortOf = (cfg: { host: string; port: number }): string =>
	cfg.host.includes(":") ? `[${cfg.host}]:${cfg.port}` : `${cfg.host}:${cfg.port}`;

/** The page's config, or the reason it cannot be read on stderr and exit code 2. */
export function loadConfigOrExit(): WebConfig {
	try {
		return loadConfig(CONF);
	} catch (e) {
		console.error(String((e as Error).message));
		process.exit(2);
	}
}
