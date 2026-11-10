import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_VERSION, normalizeConfig } from '../config.js'

test('missing or garbage config falls back to defaults', () => {
	const defaults = {
		websocket: { port: 2501 },
		runOnStartup: false,
		polling: { enabled: false, interval: 1000 },
		version: CONFIG_VERSION,
	}
	assert.deepEqual(normalizeConfig(undefined), defaults)
	assert.deepEqual(normalizeConfig('nope'), defaults)
	assert.deepEqual(normalizeConfig({ websocket: { port: 70000 }, polling: { interval: 'x' } }), defaults)
})

test('valid values are kept and out-of-range ones clamped', () => {
	assert.deepEqual(
		normalizeConfig({ websocket: { port: '8080' }, runOnStartup: 1, polling: { enabled: true, interval: 50 } }),
		{ websocket: { port: 8080 }, runOnStartup: true, polling: { enabled: true, interval: 100 }, version: CONFIG_VERSION }
	)
	assert.equal(normalizeConfig({ polling: { interval: 99999 } }).polling.interval, 10000)
})

test('the version survives a save from the settings window, which does not send it', () => {
	assert.equal(normalizeConfig({ websocket: { port: 2501 } }).version, CONFIG_VERSION)
})
