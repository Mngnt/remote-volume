import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, sep } from 'path'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

// Executables can't be spawned from inside app.asar; electron-builder unpacks them (see "asarUnpack").
const here = dirname(fileURLToPath(import.meta.url)).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
const helperPath = join(here, 'RemoteVolumeHelper.exe')
const legacyPath = join(here, 'adjust_get_current_system_volume_vista_plus.exe')
const REQUEST_TIMEOUT_MS = 5000

/**
 * Client for RemoteVolumeHelper.exe: one long-lived process that answers each command with one JSON line.
 * Requests are serialized, and the process is (re)started on demand if it exits.
 */
class Helper {
	proc = null
	pending = null
	queue = Promise.resolve()

	request(command) {
		const result = this.queue.then(() => this.#send(command))
		this.queue = result.catch(() => {})
		return result
	}

	#start() {
		const proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
		createInterface({ input: proc.stdout }).on('line', (line) => this.#settle(null, line))
		const onGone = (error) => {
			if (this.proc !== proc) return
			this.proc = null
			this.#settle(error || new Error('Volume helper exited'))
		}
		proc.on('error', onGone)
		proc.on('exit', () => onGone())
		proc.stdin.on('error', () => {}) // surfaced through 'exit'
		this.proc = proc
	}

	#send(command) {
		if (!this.proc) this.#start()
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.proc?.kill()
				this.#settle(new Error(`Volume helper timed out on "${command}"`))
			}, REQUEST_TIMEOUT_MS)
			this.pending = { resolve, reject, timer }
			this.proc.stdin.write(command + '\n')
		})
	}

	#settle(error, line) {
		const pending = this.pending
		if (!pending) return
		this.pending = null
		clearTimeout(pending.timer)
		if (error) return pending.reject(error)
		let data
		try {
			data = JSON.parse(line)
		} catch {
			return pending.reject(new Error(`Unexpected output from volume helper: ${line}`))
		}
		if (data.error) pending.reject(new Error(data.error))
		else pending.resolve(data)
	}
}

const helper = existsSync(helperPath) ? new Helper() : null

// Fallback when RemoteVolumeHelper.exe hasn't been built: master volume only, one process per call.
async function legacy(...args) {
	const { stdout } = await promisify(execFile)(legacyPath, args, { windowsHide: true })
	const [volume, muted] = stdout.trim().split(' ')
	return { volume: parseInt(volume, 10), muted: Boolean(parseInt(muted, 10)) }
}

export async function getState() {
	if (!helper) return legacy()
	const { volume, muted, device } = await helper.request('get')
	return { volume, muted, outputDevice: device ?? '' }
}

export async function getVolume() {
	return (await getState()).volume
}

export async function getMuted() {
	return (await getState()).muted
}

export async function setVolume(value) {
	if (helper) await helper.request(`set-volume ${value}`)
	else await legacy(String(value))
}

export async function setMuted(muted) {
	if (helper) await helper.request(`set-mute ${muted ? 1 : 0}`)
	else await legacy(muted ? 'mute' : 'unmute')
}

export const supportsSessions = Boolean(helper)

// Sessions are keyed by process id; the helper applies a change to every session of that process.
export async function listSessions() {
	const { apps } = await helper.request('apps')
	return apps.map(({ pid, name, title, volume, muted, active }) => ({ id: pid, pid, name, title, volume, muted, active }))
}

export async function setSessionVolume(id, value) {
	await helper.request(`app-volume ${id} ${value}`)
}

export async function setSessionMuted(id, muted) {
	await helper.request(`app-mute ${id} ${muted ? 1 : 0}`)
}
