import { app, BrowserWindow, Tray, Menu, ipcMain } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import Store from 'electron-store'
import AutoLaunch from 'electron-auto-launch'
import log from 'electron-log'
import * as controller from './volumeController.js'
import { createRemoteVolumeServer } from './server.js'
import { normalizeConfig } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs/main.log')
log.info('App is starting...')

if (!app.requestSingleInstanceLock()) {
	log.info('Another instance of the app is already running. Exiting.')
	app.quit()
} else {
	run()
}

function run() {
	const store = new Store()
	let config = normalizeConfig(store.get('settings'))
	store.set('settings', config)

	// Launched at login (Windows/Linux pass --hidden, macOS reports it): stay in the tray.
	const launchedHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden

	let mainWindow = null
	let tray = null
	let server = null
	let serverError = null
	let quitting = false

	const describeServerError = (error) =>
		error?.code === 'EADDRINUSE'
			? `Port ${config.websocket.port} is already in use. Choose another port.`
			: `Could not start the WebSocket server: ${error?.message ?? error}`

	async function startServer() {
		server = createRemoteVolumeServer({ controller, log, port: config.websocket.port, polling: config.polling })
		try {
			await server.start()
			serverError = null
		} catch (error) {
			serverError = describeServerError(error)
			log.error(serverError)
		}
	}

	async function setAutoLaunch(enabled) {
		try {
			if (process.platform === 'linux') {
				const launcher = new AutoLaunch({ name: 'RemoteVolume', path: app.getPath('exe'), isHidden: true })
				if ((await launcher.isEnabled()) !== enabled) {
					if (enabled) await launcher.enable()
					else await launcher.disable()
				}
			} else {
				app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] })
			}
			log.info(`Auto-launch ${enabled ? 'enabled' : 'disabled'}.`)
		} catch (error) {
			log.error('Failed to change auto-launch setting:', error)
		}
	}

	function showWindow() {
		if (!mainWindow) return
		mainWindow.show()
		mainWindow.focus()
	}

	function statusMessage(okMessage) {
		return serverError ? { ok: false, message: serverError } : { ok: true, message: okMessage }
	}

	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 400,
			height: 570,
			useContentSize: true, // size the page area, not the frame, so the form isn't clipped
			resizable: false,
			show: false,
			webPreferences: {
				contextIsolation: true,
				preload: path.join(__dirname, 'renderer.js'),
			},
			icon: path.join(__dirname, 'icon.ico'),
		})
		mainWindow.setMenu(null)
		mainWindow.loadFile('index.html')

		mainWindow.webContents.on('did-finish-load', () => {
			mainWindow.webContents.send('load-config', config)
			if (serverError) mainWindow.webContents.send('config-saved', statusMessage(''))
		})

		// Closing the window only hides it; the app keeps running in the tray until Quit.
		mainWindow.on('close', (event) => {
			if (!quitting) {
				event.preventDefault()
				mainWindow.hide()
			}
		})
	}

	app.on('second-instance', showWindow) // launching the app again opens its settings
	app.on('activate', showWindow)
	app.on('before-quit', () => {
		quitting = true // also covers Cmd+Q on macOS, which used to only hide the window
	})
	app.on('will-quit', () => {
		server?.stop()
	})

	app.whenReady().then(async () => {
		if (process.platform === 'darwin') app.dock.hide()

		createWindow()

		tray = new Tray(path.join(__dirname, 'menuicon.png'))
		tray.setToolTip('Remote Volume')
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: 'Show App', click: showWindow },
				{ label: 'Quit', click: () => app.quit() },
			])
		)

		await setAutoLaunch(config.runOnStartup)
		await startServer()

		if (!launchedHidden || serverError) mainWindow.show()

		ipcMain.on('request-config', (event) => event.reply('load-config', config))

		ipcMain.on('save-config', async (event, submitted) => {
			const previous = config
			config = normalizeConfig(submitted)
			store.set('settings', config)
			event.reply('load-config', config)

			if (config.runOnStartup !== previous.runOnStartup) await setAutoLaunch(config.runOnStartup)

			// Only rebind when needed: restarting disconnects every client.
			if (config.websocket.port !== previous.websocket.port || serverError) {
				log.info('Restarting the WebSocket server to apply the new port.')
				await server.stop()
				await startServer()
			} else {
				server.updatePolling(config.polling)
			}

			event.reply('config-saved', statusMessage('Saved.'))
		})
	})

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit()
	})
}
