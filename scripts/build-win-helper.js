// Compiles impl/windows/RemoteVolumeHelper.cs with the C# compiler that ships with the .NET Framework
// (present on every Windows 10/11 install and on GitHub's Windows runners). It's a no-op on other
// platforms and when the exe is already newer than its source; pass --force to rebuild anyway.
import { execFileSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'win32') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'impl', 'windows', 'RemoteVolumeHelper.cs')
const output = join(root, 'impl', 'windows', 'RemoteVolumeHelper.exe')
const force = process.argv.includes('--force')

if (!force && existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0)

const windir = process.env.WINDIR || 'C:\\Windows'
const csc = ['Framework64', 'Framework']
	.map((dir) => join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
	.find((path) => existsSync(path))

if (!csc) {
	console.error('build-win-helper: csc.exe (.NET Framework 4) not found; cannot build RemoteVolumeHelper.exe')
	process.exit(1)
}

execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${output}`, source], {
	stdio: 'inherit',
})
console.log(`build-win-helper: built ${output}`)
