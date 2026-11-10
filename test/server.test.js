import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createRemoteVolumeServer } from '../server.js'
import { groupSessions, findApp, publicApp } from '../apps.js'

const silent = { info() {}, warn() {}, error() {} }

// In-memory stand-in for volumeController.js.
function fakeController({ supportsApps = true } = {}) {
	const state = { volume: 40, muted: false, outputDevice: 'Speakers' }
	const sessions = [
		{ id: 10, pid: 10, name: 'Spotify', title: 'Spotify', volume: 80, muted: false, active: true },
		{ id: 11, pid: 11, name: 'chrome', title: 'Google Chrome', volume: 100, muted: false, active: true },
		{ id: 12, pid: 12, name: 'chrome', title: 'Google Chrome', volume: 50, muted: false, active: false },
	]
	const clamp = (v) => Math.min(100, Math.max(0, Math.round(v)))
	const resolve = (target) => {
		const group = findApp(groupSessions(sessions), target)
		if (!group) throw new Error('No app with an audio session matches')
		return sessions.filter((s) => group.ids.includes(s.id))
	}
	const loudest = (group) => Math.max(...group.map((s) => s.volume))
	return {
		state,
		sessions,
		supportsApps,
		getState: async () => ({ ...state }),
		isMuted: async () => state.muted,
		setVolume: async (v) => void (state.volume = clamp(v)),
		increaseVolume: async (v) => void (state.volume = clamp(state.volume + v)),
		decreaseVolume: async (v) => void (state.volume = clamp(state.volume - v)),
		mute: async () => void (state.muted = true),
		unmute: async () => void (state.muted = false),
		toggleMute: async () => void (state.muted = !state.muted),
		listApps: async () => {
			if (!supportsApps) throw new Error('Per-application volume is not supported on macOS')
			return groupSessions(sessions).map(publicApp)
		},
		setAppVolume: async (t, v) => resolve(t).forEach((s) => (s.volume = clamp(v))),
		increaseAppVolume: async (t, v) => {
			const group = resolve(t)
			const top = loudest(group)
			group.forEach((s) => (s.volume = clamp(top + v)))
		},
		decreaseAppVolume: async (t, v) => {
			const group = resolve(t)
			const top = loudest(group)
			group.forEach((s) => (s.volume = clamp(top - v)))
		},
		muteApp: async (t) => resolve(t).forEach((s) => (s.muted = true)),
		unmuteApp: async (t) => resolve(t).forEach((s) => (s.muted = false)),
		toggleAppMute: async (t) => {
			const group = resolve(t)
			const muted = group.every((s) => s.muted)
			group.forEach((s) => (s.muted = !muted))
		},
	}
}

// A client that records every message and can wait for (and consume) one matching a predicate.
async function connect(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`)
	const messages = []
	const waiters = []
	ws.on('message', (raw) => {
		const msg = JSON.parse(raw)
		const waiter = waiters.find((w) => w.match(msg))
		if (waiter) {
			waiters.splice(waiters.indexOf(waiter), 1)
			waiter.resolve(msg)
		} else {
			messages.push(msg)
		}
	})
	await new Promise((resolve, reject) => {
		ws.once('open', resolve)
		ws.once('error', reject)
	})
	return {
		ws,
		messages,
		send: (data) => ws.send(JSON.stringify(data)),
		next(match, timeout = 2000) {
			const seen = messages.find(match)
			if (seen) {
				messages.splice(messages.indexOf(seen), 1)
				return Promise.resolve(seen)
			}
			return new Promise((resolve, reject) => {
				const waiter = {
					match,
					resolve: (msg) => {
						clearTimeout(timer)
						resolve(msg)
					},
				}
				const timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1)
					reject(new Error('Timed out waiting for message'))
				}, timeout)
				waiters.push(waiter)
			})
		},
		close: () => ws.close(),
	}
}

const isMaster = (m) => 'volume' in m || 'muted' in m || 'outputDevice' in m
const isApps = (m) => 'apps' in m
const isError = (m) => 'response' in m

let controller
let server
let client

async function startWith(ctrl) {
	controller = ctrl
	server = createRemoteVolumeServer({ controller, log: silent, port: 0, polling: { enabled: false, interval: 100 } })
	await server.start()
	client = await connect(server.port)
}

beforeEach(() => startWith(fakeController()))

afterEach(async () => {
	client?.close()
	await server.stop()
})

test('a new client receives master state, then the app list', async () => {
	assert.deepEqual(await client.next(isMaster), { volume: 40, muted: false, outputDevice: 'Speakers' })
	const { apps } = await client.next(isApps)
	assert.deepEqual(
		apps.map((a) => [a.name, a.volume, a.pids]),
		[
			['chrome', 100, [11, 12]],
			['Spotify', 80, [10]],
		]
	)
})

test('Companion actions push the new master state back without polling', async () => {
	await client.next(isMaster)
	client.send({ action: 'setVolume', value: 55 })
	// The first refresh has no baseline yet, so it carries every master field; later ones only changes.
	assert.deepEqual(await client.next(isMaster), { volume: 55, muted: false, outputDevice: 'Speakers' })
	client.send({ action: 'increaseVolume', value: 10 })
	assert.deepEqual(await client.next(isMaster), { volume: 65 })
	client.send({ action: 'decreaseVolume', value: 99 })
	assert.deepEqual(await client.next(isMaster), { volume: 0 })
	client.send({ action: 'mute' })
	assert.deepEqual(await client.next(isMaster), { muted: true })
	client.send({ action: 'toggleMute' })
	assert.deepEqual(await client.next(isMaster), { muted: false })
	client.send({ action: 'unmute' })
	client.send({ action: 'getState' })
	assert.deepEqual(await client.next(isMaster), { volume: 0, muted: false, outputDevice: 'Speakers' })
})

test('master changes are broadcast to every connected client', async () => {
	const other = await connect(server.port)
	await other.next(isMaster)
	await client.next(isMaster)
	client.send({ action: 'setVolume', value: 70 })
	assert.equal((await other.next(isMaster)).volume, 70)
	other.close()
})

test('isMuted is implemented', async () => {
	await client.next(isMaster)
	controller.state.muted = true
	client.send({ action: 'isMuted' })
	assert.deepEqual(await client.next(isMaster), { muted: true })
})

test('invalid values and actions keep the original error format', async () => {
	await client.next(isMaster)
	client.send({ action: 'setVolume', value: 101 })
	assert.deepEqual(await client.next(isError), {
		action: 'setVolume',
		response: { error: 'Invalid value for setVolume. Must be between 0 and 100.' },
	})
	client.send({ action: 'nope' })
	assert.deepEqual(await client.next(isError), { action: 'nope', response: { error: 'Invalid action' } })
	client.send({ action: 'toString' })
	assert.deepEqual(await client.next(isError), { action: 'toString', response: { error: 'Invalid action' } })
	client.ws.send('not json')
	assert.deepEqual(await client.next((m) => 'error' in m), { error: 'Failed to process message' })
	assert.equal(controller.state.volume, 40)
})

test('per-app actions change only the targeted app and broadcast under "apps"', async () => {
	await client.next(isApps)
	client.send({ action: 'setAppVolume', app: 'Spotify.exe', value: 25 })
	let { apps } = await client.next(isApps)
	assert.equal(apps.find((a) => a.name === 'Spotify').volume, 25)
	assert.equal(apps.find((a) => a.name === 'chrome').volume, 100)

	client.send({ action: 'toggleAppMute', pid: 12 })
	;({ apps } = await client.next(isApps))
	assert.equal(apps.find((a) => a.name === 'chrome').muted, true)
	assert.ok(controller.sessions.filter((s) => s.name === 'chrome').every((s) => s.muted))

	client.send({ action: 'decreaseAppVolume', app: 'google chrome', value: 30 })
	;({ apps } = await client.next(isApps))
	assert.equal(apps.find((a) => a.name === 'chrome').volume, 70)
	assert.equal(controller.state.volume, 40, 'master volume untouched')
})

test('per-app messages never carry top-level master keys (Companion would misread them)', async () => {
	await client.next(isMaster)
	await client.next(isApps)
	client.send({ action: 'getApps' })
	client.send({ action: 'setAppVolume', app: 'spotify', value: 10 })
	client.send({ action: 'muteApp', app: 'missing' })
	client.send({ action: 'setAppVolume', value: 10 })
	await client.next(isApps)
	await client.next(isApps)
	const errors = [(await client.next(isError)).response.error, (await client.next(isError)).response.error].sort()
	assert.match(errors[0], /Missing "app"/)
	assert.match(errors[1], /No app/)
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(client.messages.filter(isMaster), [])
})

test('per-app requests on an unsupported platform return an error', async () => {
	client.close()
	await server.stop()
	await startWith(fakeController({ supportsApps: false }))
	await client.next(isMaster)
	client.send({ action: 'getApps' })
	assert.deepEqual(await client.next(isError), {
		action: 'getApps',
		response: { error: 'Per-application volume is not supported on macOS' },
	})
	assert.deepEqual(client.messages.filter(isApps), [])
})

test('a burst of relative app steps (rotary encoder) loses no steps and coalesces refreshes', async () => {
	await client.next(isApps)
	// Like the real backend: read the volume, wait for the system, then write it.
	controller.decreaseAppVolume = async (t, v) => {
		const top = Math.max(...controller.sessions.filter((s) => s.name === 'Spotify').map((s) => s.volume))
		await new Promise((r) => setTimeout(r, 5))
		controller.sessions.filter((s) => s.name === 'Spotify').forEach((s) => (s.volume = top - v))
	}
	let listCalls = 0
	const listApps = controller.listApps
	controller.listApps = async () => {
		listCalls++
		await new Promise((r) => setTimeout(r, 5))
		return listApps()
	}
	for (let i = 0; i < 10; i++) client.send({ action: 'decreaseAppVolume', app: 'spotify', value: 5 })
	let spotify
	while (spotify !== 30) {
		const { apps } = await client.next(isApps)
		spotify = apps.find((a) => a.name === 'Spotify').volume
		assert.ok(spotify >= 30, `went past the target: ${spotify}`)
	}
	assert.equal(controller.sessions[0].volume, 30, '80 - 10 x 5')
	assert.ok(listCalls < 10, `expected coalesced refreshes, got ${listCalls} app list reads`)
})

test('polling broadcasts external changes, and only the fields that changed', async () => {
	await client.next(isMaster)
	await client.next(isApps)
	server.updatePolling({ enabled: true, interval: 20 })
	await client.next(isMaster) // first poll establishes the baseline
	await client.next(isApps)
	controller.state.volume = 12
	assert.deepEqual(await client.next(isMaster), { volume: 12 })
	controller.sessions[0].muted = true
	const { apps } = await client.next(isApps)
	assert.equal(apps.find((a) => a.name === 'Spotify').muted, true)
	server.updatePolling({ enabled: false, interval: 20 })
})

test('polls never overlap, even when the backend is slower than the interval', async () => {
	let inFlight = 0
	let maxInFlight = 0
	let calls = 0
	const getState = controller.getState
	controller.getState = async () => {
		calls++
		inFlight++
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise((r) => setTimeout(r, 30))
		inFlight--
		return getState()
	}
	server.updatePolling({ enabled: true, interval: 5 })
	await new Promise((r) => setTimeout(r, 200))
	server.updatePolling({ enabled: false, interval: 5 })
	assert.ok(calls >= 3, `expected several polls, got ${calls}`)
	assert.equal(maxInFlight, 1)
})

test('start rejects when the port is taken', async () => {
	const second = createRemoteVolumeServer({
		controller,
		log: silent,
		port: server.port,
		polling: { enabled: false, interval: 100 },
	})
	await assert.rejects(second.start(), { code: 'EADDRINUSE' })
})
