import type { WakeTransport } from "../core/delivery/deliver.ts";

export const transport = () => {
	const sent: { deliveryId: string; message: string }[] = [];
	const t: WakeTransport = {
		ready: () => true,
		send: async (deliveryId, message) => {
			sent.push({ deliveryId, message });
			return { ok: true, status: 202 };
		},
	};
	return { t, sent };
};

export const row = (deliveryId: string, over: Record<string, unknown> = {}) => ({
	deliveryId,
	message: `m ${deliveryId}`,
	queuedAt: Date.now(),
	...over,
});
