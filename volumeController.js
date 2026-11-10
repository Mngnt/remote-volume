import os from 'os'
import { findApp, groupSessions, publicApp } from './apps.js'

let impl = null

switch (os.type()) {
	case 'Darwin':
		impl = await import('./impl/darwin.js')
		break
	case 'Linux':
		impl = await import('./impl/linux.js')
		break
	case 'Windows_NT':
		impl = await import('./impl/windows/index.js')
		break
	default:
		throw new Error('Your OS is currently not supported by node-loudness.')
}

// Errors caused by the request rather than the system: reported to the client, not logged as failures.
export class AppNotFoundError extends Error {
	isClientError = true
}
export class NotSupportedError extends Error {
	isClientError = true
}

const clamp = (value) => Math.min(100, Math.max(0, Math.round(value)))

// naudiodon (PortAudio) is only needed where the backend can't name the output device itself. It's an
// optional native dependency, so it's loaded lazily and its absence just means an empty device name.
let naudiodon
async function portAudioDeviceName() {
	naudiodon ??= import('@capaj/naudiodon').catch(() => null)
	const lib = await naudiodon
	if (!lib) return ''
	const hostAPIs = lib.getHostAPIs()
	const defaultOutput = hostAPIs.HostAPIs[hostAPIs.defaultHostAPI]?.defaultOutput
	return lib.getDevices().find((d) => d.id === defaultOutput)?.name ?? ''
}

export async function getAudioDevice() {
	try {
		if (impl.getAudioDevice) return await impl.getAudioDevice()
	} catch {
		// fall through to PortAudio
	}
	try {
		return await portAudioDeviceName()
	} catch {
		return ''
	}
}

/** Master volume, mute state and output device name, using as few backend calls as possible. */
export async function getState() {
	const { volume, muted, outputDevice } = await impl.getState()
	return { volume, muted, outputDevice: outputDevice ?? (await getAudioDevice()) }
}

export async function getVolume() {
	return (await impl.getState()).volume
}

export async function isMuted() {
	return (await impl.getState()).muted
}

export async function setVolume(value) {
	return impl.setVolume(clamp(value))
}

export async function mute() {
	return impl.setMuted(true)
}

export async function unmute() {
	return impl.setMuted(false)
}

export async function toggleMute() {
	return impl.setMuted(!(await isMuted()))
}

export async function increaseVolume(amount) {
	return impl.setVolume(clamp((await getVolume()) + amount))
}

export async function decreaseVolume(amount) {
	return impl.setVolume(clamp((await getVolume()) - amount))
}

// ----- per-application volume -----

export const supportsApps = Boolean(impl.supportsSessions)

function requireApps() {
	if (!supportsApps) {
		throw new NotSupportedError(
			os.type() === 'Darwin'
				? 'Per-application volume is not supported on macOS'
				: 'Per-application volume is not available on this system'
		)
	}
}

/** Apps that currently have an audio session: [{ name, title, pids, volume, muted, active }]. */
export async function listApps() {
	requireApps()
	return groupSessions(await impl.listSessions()).map(publicApp)
}

async function resolveApp(target) {
	requireApps()
	const group = findApp(groupSessions(await impl.listSessions()), target)
	if (!group) {
		const what = target.pid != null && target.pid !== '' ? `process ${target.pid}` : `"${target.app}"`
		throw new AppNotFoundError(`No app with an audio session matches ${what}`)
	}
	return group
}

async function applyVolume(group, value) {
	for (const id of group.ids) await impl.setSessionVolume(id, clamp(value))
}

async function applyMuted(group, muted) {
	for (const id of group.ids) await impl.setSessionMuted(id, muted)
}

export async function setAppVolume(target, value) {
	await applyVolume(await resolveApp(target), value)
}

export async function increaseAppVolume(target, amount) {
	const group = await resolveApp(target)
	await applyVolume(group, group.volume + amount)
}

export async function decreaseAppVolume(target, amount) {
	const group = await resolveApp(target)
	await applyVolume(group, group.volume - amount)
}

export async function muteApp(target) {
	await applyMuted(await resolveApp(target), true)
}

export async function unmuteApp(target) {
	await applyMuted(await resolveApp(target), false)
}

export async function toggleAppMute(target) {
	const group = await resolveApp(target)
	await applyMuted(group, !group.muted)
}
