// Settings persisted in electron-store under the "settings" key.

export const CONFIG_VERSION = '1.0.0'
export const DEFAULT_PORT = 2501
export const DEFAULT_POLLING_INTERVAL = 1000

function integer(value) {
	const n = typeof value === 'string' ? Number(value) : value
	return Number.isInteger(n) ? n : NaN
}

/** Returns a complete, valid config from whatever was stored or sent by the settings window. */
export function normalizeConfig(input) {
	const c = input && typeof input === 'object' ? input : {}
	const port = integer(c.websocket?.port)
	const interval = integer(c.polling?.interval)
	return {
		websocket: { port: port >= 1 && port <= 65535 ? port : DEFAULT_PORT },
		runOnStartup: Boolean(c.runOnStartup),
		polling: {
			enabled: Boolean(c.polling?.enabled),
			interval: Number.isNaN(interval) ? DEFAULT_POLLING_INTERVAL : Math.min(10000, Math.max(100, interval)),
		},
		version: CONFIG_VERSION,
	}
}
