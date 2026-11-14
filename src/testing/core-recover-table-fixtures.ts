import type { RunFailure } from "../core/adapter-inspect.ts";
import type { FailureKind } from "../core/recover-classify.ts";
import { NOW } from "./core-recover-fixtures.ts";

/** The failures T3 recorded for real runs since 2026-10-25, one row each: what the table must say about them. */
export const TABLE: { name: string; f: Partial<RunFailure>; kind: FailureKind; retry: boolean }[] = [
	{
		name: "rate limit (33 runs)",
		f: { class: "usage_limit", code: "api_error_429", message: "Claude API rate limit reached. Try again later." },
		kind: "rate_limit",
		retry: true,
	},
	{
		name: "stream closed (20 runs)",
		f: {
			class: "unknown",
			message:
				"The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.",
		},
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "provider turn failed",
		f: { class: "transport_error", message: "Provider turn failed." },
		kind: "provider_turn_failed",
		retry: true,
	},
	{
		name: "response stream disconnected",
		f: {
			class: "transport_error",
			code: "responseStreamDisconnected",
			retryable: true,
			message: "workspace routing discovery timed out",
		},
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "routing discovery timed out, class other",
		f: { class: "provider_error", code: "other", message: "workspace routing discovery timed out" },
		kind: "stream_closed",
		retry: true,
	},
	{
		name: "server error 503",
		f: { class: "provider_error", code: "api_error_503", retryable: true, message: "Claude API server error." },
		kind: "capacity",
		retry: true,
	},
	{
		name: "model at capacity",
		f: {
			class: "provider_error",
			code: "serverOverloaded",
			message: "Error running remote compact task: Selected model is at capacity. Please try a different model.",
		},
		kind: "capacity",
		retry: true,
	},
	{
		name: "out of memory",
		f: { class: "transport_error", code: "oom_kill", message: "Killed: out of memory." },
		kind: "oom",
		retry: true,
	},
	{
		name: "auth",
		f: {
			class: "provider_error",
			code: "api_error",
			message:
				"Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread.",
		},
		kind: "auth",
		retry: false,
	},
	{
		name: "Cloudflare 403",
		f: {
			class: "provider_error",
			code: "api_error_403",
			message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		},
		kind: "cloudflare",
		retry: false,
	},
	{
		name: "safety: misalignment policy",
		f: {
			class: "provider_error",
			code: "misalignmentPolicyViolation",
			message: "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
		},
		kind: "safety",
		retry: false,
	},
	{
		name: "safety: cyber policy",
		f: {
			class: "provider_error",
			code: "cyberPolicy",
			message: "This content was flagged for possible cybersecurity risk.",
		},
		kind: "safety",
		retry: false,
	},
	{
		name: "workspace preparation",
		f: {
			class: "validation_error",
			code: "workspace_preparation_failed",
			retryable: false,
			message:
				"Workspace preparation failed during provision worktree: Git command failed in GitVcsDriver.createWorktree.createBranch (/home/x/dev/Y)",
		},
		kind: "workspace",
		retry: false,
	},
	{
		name: "git error without a code",
		f: { message: "Git command failed in GitVcsDriver.status" },
		kind: "workspace",
		retry: false,
	},
	{
		name: "quota by message",
		f: { class: "usage_limit", code: "api_error_429", message: "You have exceeded your monthly usage limit." },
		kind: "quota",
		retry: false,
	},
	{
		name: "quota by a far reset",
		f: {
			class: "usage_limit",
			code: "api_error_429",
			message: "Claude API rate limit reached.",
			resetAt: new Date(NOW + 5 * 3600_000).toISOString(),
		},
		kind: "quota",
		retry: false,
	},
	{
		name: "interrupted flag",
		f: { message: "Provider turn failed.", interrupted: true },
		kind: "interrupted",
		retry: false,
	},
	{
		name: "anything else is unknown",
		f: { class: "weird", message: "something nobody has seen" },
		kind: "unknown",
		retry: false,
	},
	{ name: "an empty message is unknown", f: { message: "" }, kind: "unknown", retry: false },
];
