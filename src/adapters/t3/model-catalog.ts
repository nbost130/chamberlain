/** T3's initial config stream omits blocking network discovery; no cached Chamberlain selection path. */
import type { Rpc } from "./rpc.ts";
import { firstValue } from "./rpc-first.ts";

type Descriptor = { id: string; type: string; options?: { id: string }[] };
export type Catalog = {
	providers: {
		instanceId: string;
		driver?: string;
		enabled: boolean;
		installed: boolean;
		availability?: string;
		auth?: { status?: string };
		status?: string;
		usageLimits?: { windows: { usedPercent: number; resetsAt?: string }[] };
		models: { slug: string; capabilities?: { optionDescriptors?: Descriptor[] } | null }[];
	}[];
};

export async function readModelCatalog(rpc: Pick<Rpc, "call">): Promise<Catalog> {
	const value = (await firstValue(rpc, "subscribeServerConfig", {
		workspaceSnapshotsOnDemand: true,
		providerCatalogsOnDemand: true,
	})) as { type?: string; config?: Catalog };
	if (value?.type !== "snapshot" || !Array.isArray(value.config?.providers))
		throw Error("provider catalog snapshot unavailable");
	return value.config;
}
