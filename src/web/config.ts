/** The queue page's config: the `web` section of ~/.config/chamberlain/config.json. It must name the one address to bind, never a wildcard. */
import { CONFIG_FILE, cfg } from "../core/layout.ts";
import { SCHEMA_VERSION, checkVersion } from "../core/schema.ts";

export type WebConfig = {
	schemaVersion?: number;
	/** The one address to listen on, canonical: this machine's Tailscale IP, or loopback. */
	host: string;
	port: number;
	/** Extra Host header names to accept, such as the machine's MagicDNS name. The bind address is always accepted. */
	allowedHosts?: string[];
	/** Per server, the T3 web URL prefix a thread id is appended to ("https://…/threads/<environmentId>/"). */
	threadLinks?: Record<string, string>;
	/**
	 * The T3 server that hosts the Decisions thread, and its orchestration:operate
	 * token file in the config dir. With it the page keeps the Decisions thread's title and can answer cards there.
	 */
	decisionsServer?: { origin: string; operateTokenFile: string };
	/** An https base URL (for example from `tailscale serve`) for the inline views, when T3 itself is loaded over https. */
	publicBase?: string;
	/** Server name -> link base for a mirrored card's thread, e.g. "t3-thread://v2/<environmentId>/". */
	mirrorLinks?: Record<string, string>;
	/** Server name -> its operate-token file in the config folder: cards there are answerable. Without one a server is read-only. */
	answerTokens?: Record<string, string>;
};

/** Pure: an IPv4 literal as its four bytes. Strict dotted decimal only: a leading zero could be read as octal elsewhere. */
function ipv4Bytes(s: string): number[] | undefined {
	const parts = s.split(".");
	if (parts.length !== 4) return undefined;
	const out: number[] = [];
	for (const p of parts) {
		if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
		const n = Number(p);
		if (n > 255) return undefined;
		out.push(n);
	}
	return out;
}

/** Pure: an IPv6 literal as its sixteen bytes, from any spelling: compressed, zero-padded, any case, an IPv4 tail. */
function ipv6Bytes(s: string): number[] | undefined {
	if (!/^[0-9a-f:.]+$/.test(s) || s.split("::").length > 2) return undefined;
	const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, undefined];
	const groups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const out: number[] = [];
		const fields = part.split(":");
		for (let k = 0; k < fields.length; k++) {
			const f = fields[k]!;
			if (k === fields.length - 1 && f.includes(".")) {
				const v4 = ipv4Bytes(f);
				if (!v4) return undefined;
				out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
			} else {
				if (!/^[0-9a-f]{1,4}$/.test(f)) return undefined;
				out.push(parseInt(f, 16));
			}
		}
		return out;
	};
	const h = groups(head);
	const t = tail === undefined ? [] : groups(tail);
	if (!h || !t) return undefined;
	// An IPv4 tail is only valid at the very end of the address.
	if (tail !== undefined && head.includes(".")) return undefined;
	let words: number[];
	if (tail === undefined) {
		if (h.length !== 8) return undefined;
		words = h;
	} else {
		if (h.length + t.length > 7) return undefined;
		words = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
	}
	return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/** Pure: RFC 5952 text for sixteen bytes: lowercase, no leading zeros, the longest run of two or more zero groups as "::". */
function ipv6Text(b: number[]): string {
	const w = Array.from({ length: 8 }, (_, k) => (b[2 * k]! << 8) | b[2 * k + 1]!);
	let best = -1,
		bestLen = 0;
	for (let k = 0; k < 8; ) {
		if (w[k] !== 0) {
			k++;
			continue;
		}
		let e = k;
		while (e < 8 && w[e] === 0) e++;
		if (e - k > bestLen) {
			best = k;
			bestLen = e - k;
		}
		k = e;
	}
	const hex = (a: number[]) => a.map((x) => x.toString(16)).join(":");
	return bestLen < 2 ? hex(w) : `${hex(w.slice(0, best))}::${hex(w.slice(best + bestLen))}`;
}

export type CanonicalIp = { family: 4 | 6; bytes: number[]; text: string };
/**
 * Pure: one canonical form for an IP literal, or undefined for anything else (host names, zone IDs, ports). An
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d in any spelling) becomes the IPv4 address it maps, so it is judged as one.
 */
export function canonicalIp(raw: string): CanonicalIp | undefined {
	const s = raw
		.trim()
		.replace(/^\[(.*)\]$/, "$1")
		.toLowerCase();
	const v4 = ipv4Bytes(s);
	if (v4) return { family: 4, bytes: v4, text: v4.join(".") };
	const v6 = ipv6Bytes(s);
	if (!v6) return undefined;
	if (v6.slice(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff) {
		const m = v6.slice(12);
		return { family: 4, bytes: m, text: m.join(".") };
	}
	return { family: 6, bytes: v6, text: ipv6Text(v6) };
}

/** Pure: do the first `bits` bits of two byte strings agree? */
const inPrefix = (a: number[], prefix: number[], bits: number) => {
	for (let k = 0; k < bits; k++)
		if (((a[k >> 3]! >> (7 - (k & 7))) & 1) !== ((prefix[k >> 3]! >> (7 - (k & 7))) & 1)) return false;
	return true;
};
const TAILSCALE_V4 = [100, 64, 0, 0]; // 100.64.0.0/10, Tailscale's CGNAT range
const TAILSCALE_V6 = ipv6Bytes("fd7a:115c:a1e0::")!; // fd7a:115c:a1e0::/48, Tailscale's ULA range

/** Pure: may the page listen here? Only loopback (127.0.0.1, ::1) or a Tailscale address. Everything else is refused. */
export function allowedBind(ip: CanonicalIp): boolean {
	if (ip.family === 4) return ip.text === "127.0.0.1" || inPrefix(ip.bytes, TAILSCALE_V4, 10);
	return ip.text === "::1" || inPrefix(ip.bytes, TAILSCALE_V6, 48);
}

/** Pure: the canonical bind address, or why it is refused. Only an allowed IP literal, so no name can resolve to a wildcard. */
export function checkBind(host: unknown): string {
	if (typeof host !== "string" || !host.trim())
		throw Error(
			'web.json: no bind address. Set "host" to this machine\'s Tailscale IP (or 127.0.0.1); the page never binds to every interface.',
		);
	const ip = canonicalIp(host);
	if (!ip) throw Error(`web.json: "${host}" is not an IP address. Give the Tailscale IP itself.`);
	if (!allowedBind(ip))
		throw Error(
			`web.json: "${host}" (${ip.text}) is not loopback or a Tailscale address. The page binds only to 127.0.0.1, ::1, 100.64.0.0/10 or fd7a:115c:a1e0::/48, never a wildcard or a public interface.`,
		);
	return ip.text;
}

export function parseConfig(raw: unknown): WebConfig {
	const o = (raw ?? {}) as Record<string, unknown>;
	checkVersion("web.json", o.schemaVersion);
	const host = checkBind(o.host);
	const port = Number(o.port ?? 3790);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("web.json: port must be 1-65535");
	return {
		schemaVersion: SCHEMA_VERSION,
		host,
		port,
		...(Array.isArray(o.allowedHosts) ? { allowedHosts: o.allowedHosts.map(String) } : {}),
		...(o.threadLinks && typeof o.threadLinks === "object"
			? { threadLinks: o.threadLinks as Record<string, string> }
			: {}),
		...(o.mirrorLinks && typeof o.mirrorLinks === "object"
			? { mirrorLinks: o.mirrorLinks as Record<string, string> }
			: {}),
		...(o.answerTokens && typeof o.answerTokens === "object"
			? {
					answerTokens: Object.fromEntries(
						Object.entries(o.answerTokens as Record<string, unknown>).filter(
							([k, v]) =>
								!["__proto__", "constructor", "prototype"].includes(k) &&
								typeof v === "string" &&
								/^[A-Za-z0-9._-]+$/.test(v),
						),
					) as Record<string, string>,
				}
			: {}),
		...(o.decisionsServer && typeof o.decisionsServer === "object"
			? { decisionsServer: o.decisionsServer as WebConfig["decisionsServer"] }
			: {}),
		...(typeof o.publicBase === "string" ? { publicBase: o.publicBase } : {}),
	};
}

/** The page's config: the `web` section of config.json (else the legacy web.json). Without one the page does not start. */
export function loadConfig(conf: string): WebConfig {
	const w = cfg(conf, "web");
	if (w === undefined)
		throw Error(
			`no "web" section in ${conf}/${CONFIG_FILE}. Add {"web": {"host": "<Tailscale IP>", "port": 3790}} there first; the page never binds without an address.`,
		);
	return parseConfig(w);
}
