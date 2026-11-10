import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findApp, groupSessions, normalizeAppName, publicApp } from '../apps.js'

const sessions = [
	{ id: 1, pid: 1, name: 'chrome', title: 'Google Chrome', volume: 30, muted: true, active: false },
	{ id: 2, pid: 2, name: 'chrome', title: 'Google Chrome', volume: 90, muted: false, active: true },
	{ id: 2, pid: 2, name: 'chrome', title: 'Google Chrome', volume: 90, muted: false, active: true }, // 2nd device
	{ id: 0, pid: 0, name: 'System Sounds', title: 'System Sounds', volume: 100, muted: true, active: false },
	{ id: 7, pid: null, name: 'firefox', title: 'Firefox', volume: 100, muted: true, active: true },
]

test('normalizeAppName ignores case, whitespace and .exe', () => {
	assert.equal(normalizeAppName(' Spotify.EXE '), 'spotify')
	assert.equal(normalizeAppName('obs64'), 'obs64')
})

test('groupSessions merges sessions by process name', () => {
	const groups = groupSessions(sessions)
	assert.deepEqual(
		groups.map((g) => g.name),
		['chrome', 'firefox', 'System Sounds']
	)
	const chrome = groups[0]
	assert.deepEqual(chrome.pids, [1, 2])
	assert.deepEqual(chrome.ids, [1, 2])
	assert.equal(chrome.volume, 90, 'loudest session')
	assert.equal(chrome.muted, false, 'muted only if every session is')
	assert.equal(chrome.active, true)
	assert.deepEqual(groups[1].pids, [], 'missing pids are skipped')
	assert.deepEqual(Object.keys(publicApp(chrome)), ['name', 'title', 'pids', 'volume', 'muted', 'active'])
})

test('findApp matches by name, .exe name, title, or pid', () => {
	const groups = groupSessions(sessions)
	assert.equal(findApp(groups, { app: 'CHROME.exe' }).name, 'chrome')
	assert.equal(findApp(groups, { app: 'google chrome' }).name, 'chrome')
	assert.equal(findApp(groups, { app: 'system sounds' }).name, 'System Sounds')
	assert.equal(findApp(groups, { pid: 2 }).name, 'chrome')
	assert.equal(findApp(groups, { pid: '0' }).name, 'System Sounds')
	assert.equal(findApp(groups, { app: 'spotify' }), null)
	assert.equal(findApp(groups, { pid: 99 }), null)
	assert.equal(findApp(groups, {}), null)
})
