import { WebSocketServer } from 'ws'

// WebSocket protocol server. Kept free of Electron so it can be tested with a fake controller.
//
// Compatibility contract with the Bitfocus Companion module (companion-module-uts-remotevolume):
//   - it sends setVolume, increaseVolume, decreaseVolume, mute, unmute, toggleMute and getState;
//   - it treats ANY message with a top-level `volume`, `muted` or `outputDevice` key as master state.
// So only master-state messages may carry those keys at the top level; per-app data travels under
// `apps` (and errors under `response`), which the module ignores.

const MASTER_FIELDS = ['volume', 'muted', 'outputDevice']

class RequestError extends Error {}

function number(action, value, min, max) {
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
	if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
		throw new RequestError(`Invalid value for ${action}. Must be between ${min} and ${max}.`)
	}
	return n
}

function target(message) {
	const { app, pid } = message
	const hasApp = typeof app === 'string' && app.trim() !== ''
	const hasPid = pid != null && pid !== '' && Number.isInteger(Number(pid))
	if (!hasApp && !hasPid) throw new RequestError('Missing "app" (process name) or "pid"')
	return hasPid ? { pid: Number(pid) } : { app }
}

/**
 * @param {object} options
 * @param {object} options.controller  volumeController.js (or a test double)
 * @param {object} [options.log]       electron-log compatible logger
 * @param {number} options.port
 * @param {{enabled: boolean, interval: number}} options.polling
 */
export function createRemoteVolumeServer({ controller, log = console, port, polling }) {
	let wss = null
	let pollTimer = null
	let pollingConfig = { ...polling }
	let running = false
	// What all clients were last told, so polling and post-action refreshes only send changes.
	const last = { volume: undefined, muted: undefined, outputDevice: undefined, apps: undefined }
	const lastErrors = {}

	function send(ws, data) {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data))
	}

	function broadcast(data) {
		if (wss) for (const client of wss.clients) send(client, data)
	}

	// Logs a recurring failure (e.g. on every poll) only when its message changes.
	function logOnce(source, error) {
		const message = error?.message ?? String(error)
		if (lastErrors[source] === message) return
		lastErrors[source] = message
		log.error(`${source}:`, message)
	}

	async function refreshMaster() {
		const state = await controller.getState()
		const changed = {}
		for (const key of MASTER_FIELDS) {
			if (state[key] !== last[key]) {
				changed[key] = state[key]
				last[key] = state[key]
			}
		}
		if (Object.keys(changed).length) broadcast(changed)
	}

	async function refreshApps() {
		if (!controller.supportsApps) return
		const apps = await controller.listApps()
		const json = JSON.stringify(apps)
		if (json !== last.apps) {
			last.apps = json
			broadcast({ apps })
		}
	}

	async function poll() {
		try {
			await refreshMaster()
			delete lastErrors.master
		} catch (error) {
			logOnce('master', error)
		}
		try {
			await refreshApps()
			delete lastErrors.apps
		} catch (error) {
			logOnce('apps', error)
		}
	}

	// A chained timeout rather than setInterval, so a slow poll can never overlap the next one.
	function schedulePoll() {
		clearTimeout(pollTimer)
		pollTimer = null
		if (!running || !pollingConfig.enabled) return
		pollTimer = setTimeout(async () => {
			await poll()
			schedulePoll()
		}, pollingConfig.interval)
	}

	const masterAction = (run) => ({ run, after: refreshMaster })
	const appAction = (run) => ({ run, after: refreshApps })

	const actions = {
		// --- master volume (used by Companion) ---
		setVolume: masterAction((m) => controller.setVolume(number('setVolume', m.value, 0, 100))),
		increaseVolume: masterAction((m) => controller.increaseVolume(number('increaseVolume', m.value, 1, 99))),
		decreaseVolume: masterAction((m) => controller.decreaseVolume(number('decreaseVolume', m.value, 1, 99))),
		mute: masterAction(() => controller.mute()),
		unmute: masterAction(() => controller.unmute()),
		toggleMute: masterAction(() => controller.toggleMute()),
		getState: { run: async (m, ws) => send(ws, await controller.getState()) },
		isMuted: { run: async (m, ws) => send(ws, { muted: await controller.isMuted() }) },

		// --- per-application volume ---
		getApps: { run: async (m, ws) => send(ws, { apps: await controller.listApps() }) },
		setAppVolume: appAction((m) => controller.setAppVolume(target(m), number('setAppVolume', m.value, 0, 100))),
		increaseAppVolume: appAction((m) =>
			controller.increaseAppVolume(target(m), number('increaseAppVolume', m.value, 1, 99))
		),
		decreaseAppVolume: appAction((m) =>
			controller.decreaseAppVolume(target(m), number('decreaseAppVolume', m.value, 1, 99))
		),
		muteApp: appAction((m) => controller.muteApp(target(m))),
		unmuteApp: appAction((m) => controller.unmuteApp(target(m))),
		toggleAppMute: appAction((m) => controller.toggleAppMute(target(m))),
	}

	async function handleMessage(ws, raw) {
		let message
		try {
			message = JSON.parse(raw)
		} catch {
			log.error('Received a message that is not valid JSON')
			return send(ws, { error: 'Failed to process message' })
		}
		const action = message?.action
		const handler = typeof action === 'string' && Object.hasOwn(actions, action) ? actions[action] : null
		if (!handler) {
			log.error('Invalid action received from client:', action)
			return send(ws, { action, response: { error: 'Invalid action' } })
		}

		try {
			await handler.run(message, ws)
		} catch (error) {
			if (!(error instanceof RequestError) && !error?.isClientError) log.error(`Error handling ${action}:`, error)
			return send(ws, { action, response: { error: error.message } })
		}

		// Push the resulting state to every client straight away. Without this, clients (Companion
		// included) only learned about their own changes when polling was enabled.
		try {
			await handler.after?.()
		} catch (error) {
			log.error(`Error refreshing state after ${action}:`, error)
		}
	}

	async function sendInitialState(ws) {
		try {
			send(ws, await controller.getState())
		} catch (error) {
			log.error('Failed to read state for new client:', error)
		}
		if (controller.supportsApps) {
			try {
				send(ws, { apps: await controller.listApps() })
			} catch (error) {
				logOnce('apps', error)
			}
		}
	}

	return {
		get port() {
			return wss?.address()?.port ?? port
		},

		/** Resolves once listening; rejects (e.g. EADDRINUSE) if the port can't be bound. */
		start() {
			return new Promise((resolve, reject) => {
				const server = new WebSocketServer({ port })
				server.once('error', reject)
				server.once('listening', () => {
					server.off('error', reject)
					server.on('error', (error) => log.error('WebSocket server error:', error))
					wss = server
					running = true
					log.info(`WebSocket server started on ws://localhost:${server.address().port}`)
					schedulePoll()
					resolve()
				})
				server.on('connection', (ws) => {
					// Attach the handler first: messages arriving while the initial state is read must not be lost.
					ws.on('message', (raw) => handleMessage(ws, raw))
					ws.on('error', (error) => log.warn('WebSocket client error:', error.message))
					sendInitialState(ws)
				})
			})
		},

		async stop() {
			running = false
			clearTimeout(pollTimer)
			pollTimer = null
			const server = wss
			wss = null
			if (!server) return
			for (const client of server.clients) client.terminate()
			await new Promise((resolve) => server.close(() => resolve()))
		},

		updatePolling(next) {
			pollingConfig = { ...next }
			schedulePoll()
		},
	}
}
