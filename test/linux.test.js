import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmixerInfo, parseSinkInputsJson, parseSinkInputsText } from '../impl/linux.js'

test('parseSinkInputsJson reads pactl -f json output', () => {
	const json = JSON.stringify([
		{
			index: 42,
			corked: false,
			mute: false,
			volume: {
				'front-left': { value: 52429, value_percent: '80%', db: '-5.81 dB' },
				'front-right': { value: 45875, value_percent: '70%', db: '-9.29 dB' },
			},
			properties: {
				'application.name': 'Firefox',
				'application.process.id': '1234',
				'application.process.binary': 'firefox',
			},
		},
		{
			index: 43,
			corked: true,
			mute: true,
			volume: { mono: { value: 98304, value_percent: '150%', db: '10.57 dB' } },
			properties: { 'application.name': 'speech-dispatcher' },
		},
	])
	assert.deepEqual(parseSinkInputsJson(json), [
		{ id: 42, pid: 1234, name: 'firefox', title: 'Firefox', volume: 80, muted: false, active: true },
		{ id: 43, pid: null, name: 'speech-dispatcher', title: 'speech-dispatcher', volume: 100, muted: true, active: false },
	])
})

test('parseSinkInputsText reads plain pactl list sink-inputs output', () => {
	const text = `Sink Input #42
	Driver: protocol-native.c
	Owner Module: 10
	Client: 55
	Sink: 0
	Sample Specification: float32le 2ch 44100Hz
	Channel Map: front-left,front-right
	Format: pcm, format.sample_format = "\\"float32le\\""  format.rate = "44100"
	Corked: no
	Mute: yes
	Volume: front-left: 32768 /  50% / -18.06 dB,   front-right: 39322 /  60% / -13.31 dB
	        balance 0.17
	Buffer Latency: 22000 usec
	Properties:
		media.name = "Playback"
		application.name = "Spotify"
		application.process.id = "777"
		application.process.binary = "spotify"
Sink Input #43
	Corked: yes
	Mute: no
	Volume: mono: 65536 / 100% / 0.00 dB
	Properties:
		application.name = "mpv Media Player"
`
	assert.deepEqual(parseSinkInputsText(text), [
		{ id: 42, pid: 777, name: 'spotify', title: 'Spotify', volume: 60, muted: true, active: true },
		{ id: 43, pid: null, name: 'mpv Media Player', title: 'mpv Media Player', volume: 100, muted: false, active: false },
	])
})

test('parseAmixerInfo reads amixer get output', () => {
	const out = `Simple mixer control 'Master',0
  Capabilities: pvolume pswitch pswitch-joined
  Playback channels: Front Left - Front Right
  Limits: Playback 0 - 65536
  Mono:
  Front Left: Playback 42597 [65%] [on]
  Front Right: Playback 42597 [65%] [on]`
	assert.deepEqual(parseAmixerInfo(out), { volume: 65, muted: false })
})
