/** T3's initial config stream omits blocking network discovery; no cached Chamberlain selection path. */
import type { Rpc } from "./rpc.ts";
import { firstValue } from "./rpc-first.ts";

type Descriptor = { id: string; type: string; options?: { id: string }[] };
export type Catalog = {
	environment?: { environmentId?: string };
	settings?: {
		projectSettingsOverrides?: Record<string, { providerInstances?: Record<string, { enabled?: boolean }> }>;
	};
	providers: {
		instanceId: string;
		driver?: string;
		enabled: boolean;
		installed: boolean;
		availability?: string;
		auth?: { status?: string };
		status?: string;
		usageLimits?: {
			checkedAt?: string;
			unavailable?: unknown;
			windows: { id?: string; usedPercent: number; resetsAt?: string }[];
		};
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
