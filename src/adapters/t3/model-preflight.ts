import { ConfigFileError } from "../../core/config/layout-schema.ts";
import { type PrepareReason, preparationFailed } from "../../core/delivery/preflight.ts";
import { SchemaTooNewError } from "../../core/store/schema.ts";
import { DeadlineExceeded } from "../../core/within.ts";
import { RpcDisconnected, TicketRefused } from "./rpc.ts";

export class ModelPreparationError extends Error {
	constructor(
		readonly reason: PrepareReason,
		message: string,
	) {
		super(message);
	}
}

const networkCodes = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function networkError(error: unknown): boolean {
	if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) return true;
	if (!error || typeof error !== "object") return false;
	const { code, cause } = error as { code?: unknown; cause?: { code?: unknown } };
	return (
		(typeof code === "string" && networkCodes.has(code)) ||
		(typeof cause?.code === "string" && networkCodes.has(cause.code))
	);
}

export function preflightFailure(error: unknown) {
	if (error instanceof ModelPreparationError) return preparationFailed(error.reason);
	if (error instanceof ConfigFileError || error instanceof SchemaTooNewError) return preparationFailed("config");
	if (error instanceof RpcDisconnected || error instanceof DeadlineExceeded || networkError(error))
		return preparationFailed("unreachable");
	if (error instanceof TicketRefused) {
		if (error.status === 401 || error.status === 403) return preparationFailed("auth");
		if (error.status === 404 || error.status === 405) return preparationFailed("config");
		if (error.status >= 500) return preparationFailed("unreachable");
	}
	return preparationFailed("unknown");
}
