/** What a number is: measured, "not configured" (the operator has not asked for it), or "unavailable" (asked for, and the read failed). */
export type Status = "ok" | "not-configured" | "unavailable";
