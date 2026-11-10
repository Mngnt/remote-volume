import execa from 'execa'

async function osascript(cmd) {
	return (await execa('osascript', ['-e', cmd])).stdout
}

// One osascript call for both values; polling would otherwise spawn two processes per tick.
export async function getState() {
	const out = await osascript(
		'set s to (get volume settings)\nreturn ((output volume of s) as string) & "," & ((output muted of s) as string)'
	)
	const [volume, muted] = out.trim().split(',')
	return { volume: parseInt(volume, 10), muted: muted === 'true' }
}

export async function getVolume() {
	return (await getState()).volume
}

export async function setVolume(val) {
	await osascript('set volume output volume ' + val)
}

export async function getMuted() {
	return (await getState()).muted
}

export async function setMuted(val) {
	await osascript('set volume ' + (val ? 'with' : 'without') + ' output muted')
}

// macOS has no public API for per-application volume.
export const supportsSessions = false
