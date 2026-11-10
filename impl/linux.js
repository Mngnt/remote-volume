import execa from 'execa'

// ----- master volume: ALSA mixer (amixer) -----

async function amixer(...args) {
	return (await execa('amixer', args)).stdout
}

let defaultDeviceCache = null
const reDefaultDevice = /Simple mixer control '([a-z0-9 -]+)',[0-9]+/i

function parseDefaultDevice(data) {
	const result = reDefaultDevice.exec(data)

	if (result === null) {
		throw new Error('Alsa Mixer Error: failed to parse output')
	}

	return result[1]
}

async function getDefaultDevice() {
	if (defaultDeviceCache) return defaultDeviceCache

	return (defaultDeviceCache = parseDefaultDevice(await amixer()))
}

const reInfo = /[a-z][a-z ]*: Playback [0-9-]+ \[([0-9]+)%\] (?:[[0-9.-]+dB\] )?\[(on|off)\]/i

export function parseAmixerInfo(data) {
	const result = reInfo.exec(data)

	if (result === null) {
		throw new Error('Alsa Mixer Error: failed to parse output')
	}

	return { volume: parseInt(result[1], 10), muted: result[2] === 'off' }
}

export async function getState() {
	return parseAmixerInfo(await amixer('get', await getDefaultDevice()))
}

export const getVolume = async () => {
	return (await getState()).volume
}

export const setVolume = async (val) => {
	await amixer('set', await getDefaultDevice(), val + '%')
}

export const getMuted = async () => {
	return (await getState()).muted
}

export const setMuted = async (val) => {
	await amixer('set', await getDefaultDevice(), val ? 'mute' : 'unmute')
}

// ----- per-application volume and device name: PulseAudio / PipeWire (pactl) -----

async function pactl(...args) {
	// LC_ALL=C keeps the text output parseable; JSON keys aren't localized anyway.
	return (await execa('pactl', args, { env: { LC_ALL: 'C' } })).stdout
}

function percentOf(volume) {
	const values = Object.values(volume || {})
		.map((channel) => parseInt(channel.value_percent, 10))
		.filter((v) => !Number.isNaN(v))
	return values.length ? Math.max(...values) : 0
}

function toSession(index, props, volume, muted, corked) {
	const pid = parseInt(props['application.process.id'], 10)
	const name = props['application.process.binary'] || props['application.name'] || `sink-input-${index}`
	return {
		id: index,
		pid: Number.isNaN(pid) ? null : pid,
		name,
		title: props['application.name'] || name,
		volume: Math.min(volume, 100),
		muted,
		active: !corked,
	}
}

/** Parses `pactl -f json list sink-inputs` (pactl 16+). */
export function parseSinkInputsJson(data) {
	return JSON.parse(data).map((input) =>
		toSession(input.index, input.properties || {}, percentOf(input.volume), Boolean(input.mute), Boolean(input.corked))
	)
}

/** Parses the plain-text `pactl list sink-inputs` output of older pactl versions. */
export function parseSinkInputsText(data) {
	return data
		.split(/^Sink Input #/m)
		.slice(1)
		.map((block) => {
			const index = parseInt(block, 10)
			const props = {}
			for (const [, key, value] of block.matchAll(/^\s+([\w.]+) = "(.*)"$/gm)) props[key] = value
			const volumeLine = /^\s*Volume:(.*)$/m.exec(block)?.[1] ?? ''
			const percents = [...volumeLine.matchAll(/(\d+)%/g)].map((m) => parseInt(m[1], 10))
			const volume = percents.length ? Math.max(...percents) : 0
			const muted = /^\s*Mute: yes$/m.test(block)
			const corked = /^\s*Corked: yes$/m.test(block)
			return toSession(index, props, volume, muted, corked)
		})
}

let pactlFormat = null // null until known, then 'json' or 'text'

export async function listSessions() {
	if (pactlFormat !== 'text') {
		try {
			const sessions = parseSinkInputsJson(await pactl('-f', 'json', 'list', 'sink-inputs'))
			pactlFormat = 'json'
			return sessions
		} catch (error) {
			if (error.code === 'ENOENT') throw new Error('pactl not found; per-app volume needs PulseAudio or PipeWire')
			if (pactlFormat === 'json') throw error
			pactlFormat = 'text' // pactl older than 16 has no -f json
		}
	}
	return parseSinkInputsText(await pactl('list', 'sink-inputs'))
}

export const supportsSessions = true

export async function setSessionVolume(id, value) {
	await pactl('set-sink-input-volume', String(id), `${value}%`)
}

export async function setSessionMuted(id, muted) {
	await pactl('set-sink-input-mute', String(id), muted ? '1' : '0')
}

export async function getAudioDevice() {
	const name = (await pactl('get-default-sink')).trim()
	const sinks = JSON.parse(await pactl('-f', 'json', 'list', 'sinks'))
	return sinks.find((sink) => sink.name === name)?.description || name
}
