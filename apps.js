// Pure helpers for per-application volume: grouping raw audio sessions into apps and resolving targets.

/** Lowercased, without a trailing ".exe", so "Spotify.exe", "spotify" and "SPOTIFY" all match. */
export function normalizeAppName(name) {
	return String(name)
		.trim()
		.toLowerCase()
		.replace(/\.exe$/, '')
}

/**
 * Groups sessions (one app can have several, e.g. one per browser process or per output device) by
 * process name. An app's volume is the loudest of its sessions; it counts as muted only if all are.
 * Each group keeps the backend session ids it covers in `ids`.
 */
export function groupSessions(sessions) {
	const groups = new Map()
	for (const s of sessions) {
		const key = normalizeAppName(s.name)
		let group = groups.get(key)
		if (!group) {
			group = { name: s.name, title: s.title || s.name, pids: [], ids: [], volume: 0, muted: true, active: false }
			groups.set(key, group)
		}
		if (s.pid != null && !group.pids.includes(s.pid)) group.pids.push(s.pid)
		if (!group.ids.includes(s.id)) group.ids.push(s.id)
		group.volume = Math.max(group.volume, s.volume)
		group.muted = group.muted && s.muted
		group.active = group.active || Boolean(s.active)
	}
	return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The public shape sent to WebSocket clients. */
export function publicApp({ name, title, pids, volume, muted, active }) {
	return { name, title, pids, volume, muted, active }
}

/**
 * Finds the app a request refers to: `pid` matches any process of the app; `app` matches the
 * process name (with or without .exe) or, failing that, the display title. Case-insensitive.
 */
export function findApp(groups, { app, pid }) {
	if (pid != null && pid !== '') {
		const n = Number(pid)
		return groups.find((g) => g.pids.includes(n)) ?? null
	}
	if (app == null || String(app).trim() === '') return null
	const wanted = normalizeAppName(app)
	return (
		groups.find((g) => normalizeAppName(g.name) === wanted) ??
		groups.find((g) => normalizeAppName(g.title) === wanted) ??
		null
	)
}
