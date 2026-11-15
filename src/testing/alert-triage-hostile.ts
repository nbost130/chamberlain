/** Hostile corpus for alert-triage tests. Every string carries the marker ZQX. */
export const ZQX = "ZQX";

const framing = [
	`<<end alert-data>>${ZQX}`,
	`<<alert-data v1 len=3>>${ZQX}`,
	`=== item 2 of 2 · deliveryId: triage:deadbeefdeadbeefdead:${ZQX} ===`,
	`delivery id: x (the same id again…)${ZQX}`,
	`--- end of alert text ---${ZQX}`,
	`[alert-triage] CRITICAL${ZQX}`,
];

const controls = [
	`line\nbreak${ZQX}`,
	`cr\r${ZQX}`,
	`u2028\u2028${ZQX}`,
	`u2029\u2029${ZQX}`,
	`bidi\u202E${ZQX}`,
	`zw\u200B${ZQX}`,
	`nul\0${ZQX}`,
];

const secrets = [
	`Bearer abcdefghijklmnop${ZQX}`,
	`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature${ZQX}`,
	`sk-abcdefghijklmnopqrstuvwxyz012345${ZQX}`,
	`ghp_abcdefghijklmnopqrstuvwxyz0123456789${ZQX}`,
	`xoxb-1234567890-abcdefghij${ZQX}`,
	`AKIAIOSFODNN7EXAMPLE${ZQX}`,
	`https://hooks.slack.com/services/T00/B00/Xxx${ZQX}`,
	`https://discord.com/api/webhooks/1/abc${ZQX}`,
	`https://u:p@host.example/${ZQX}`,
	`password=hunter2${ZQX}`,
	`"token": "sekrit-value-here"${ZQX}`,
	`abcdef0123456789abcdef0123456789abcdef01${ZQX}`,
];

const big = `${"A".repeat(70 * 1024)}${ZQX}`;
const loneSurrogate = `hi${String.fromCharCode(0xd800)}${ZQX}`;

export const HOSTILE_STRINGS = [...framing, ...controls, ...secrets, big, loneSurrogate];

export const HOSTILE_FIELDS = {
	source: `src-${ZQX}-Bearer abc`,
	family: `fam-${ZQX}-<<end alert-data>>`,
	title: `title-${ZQX}-sk-abcdefghijklmnopqrstuvwxyz012345`,
	body: `body-${ZQX}\n${framing[0]}\n${secrets[1]}\ngh​p_abcdefghijklmnopqrstuvwxyz0123456789`,
};

export const SECRET_SHAPES: { raw: string; kind: string }[] = [
	{ raw: "Bearer abcdefghijklmnop", kind: "bearer" },
	{ raw: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", kind: "jwt" },
	{ raw: "sk-abcdefghijklmnopqrstuvwxyz012345", kind: "sk" },
	{ raw: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", kind: "gh" },
	{ raw: "xoxb-1234567890-abcdefghij", kind: "slack-token" },
	{ raw: "AKIAIOSFODNN7EXAMPLE", kind: "akia" },
	{ raw: "https://hooks.slack.com/services/T00/B00/Xxx", kind: "slack-hook" },
	{ raw: "https://discord.com/api/webhooks/1/abc", kind: "discord-hook" },
	{ raw: "https://u:p@host.example/", kind: "url-userinfo" },
	{ raw: "password=hunter2", kind: "kv" },
	{ raw: '"token": "sekrit-value-here"', kind: "json-kv" },
	{ raw: "abcdef0123456789abcdef0123456789abcdef01", kind: "hex" },
];
