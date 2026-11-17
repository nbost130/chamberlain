/** Mail's model selections are read from the shared config, never from a second runner configuration. */
import { cfg } from "../../core/config/layout.ts";
import { parseModels } from "../../core/llm/selection.ts";
import { parseMail } from "./config.ts";

export function mailConfig(conf: string) {
	const c = parseMail(cfg(conf, "mail"));
	if ([c.models.driver, c.models.escalate, c.models.top].some((m) => m !== "none"))
		throw Error("legacy mail.models: run chamberlain config migrate before starting mail");
	const selections = parseModels(cfg(conf, "models"));
	const slots = { driver: selections.mailDriver, escalate: selections.mailEscalate, top: selections.mailTop };
	if (c.provider !== "none" && Object.values(slots).some(Boolean) && !c.allowMailToLeaveMachine)
		throw Error("mail: configured models read mail text; set allowMailToLeaveMachine to true");
	return {
		...c,
		models: {
			command: "",
			driver: slots.driver?.model ?? "none",
			escalate: slots.escalate?.model ?? "none",
			top: slots.top?.model ?? "none",
		},
	};
}
