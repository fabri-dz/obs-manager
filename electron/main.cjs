const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { autoUpdater } = require('electron-updater')

let mainWindow
let appIsQuitting = false
let profiles = []
const runtimes = new Map()
const clients = new Map()
const launchedProcesses = new Map()
const stopping = new Set()
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: '',
  percent: 0,
  message: '',
}

if (process.env.OBS_MANAGER_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.OBS_MANAGER_USER_DATA_DIR))
}

const defaultRuntime = (profileId) => ({
  profileId,
  state: 'offline',
  streaming: false,
  startedAt: null,
  endAt: null,
  currentScene: '',
  scenes: [],
  error: '',
  outputDuration: 0,
  congestion: 0,
  skippedFrames: 0,
})

function dataPath(file) {
  return path.join(app.getPath('userData'), file)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(dataPath(file), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`No se pudo leer ${file}:`, error)
    return fallback
  }
}

async function writeJson(file, value) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  const target = dataPath(file)
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

function encryptSecret(value) {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows no habilitó el cifrado seguro para guardar credenciales.')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value) {
  if (!value) return ''
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

function sanitizeProfile(profile) {
  const { streamKeyEncrypted, obsPasswordEncrypted, ...safe } = profile
  return {
    ...safe,
    hasStreamKey: Boolean(streamKeyEncrypted),
    hasObsPassword: Boolean(obsPasswordEncrypted),
  }
}

function runtimeFor(id) {
  if (!runtimes.has(id)) runtimes.set(id, defaultRuntime(id))
  return runtimes.get(id)
}

function profileFor(id) {
  const profile = profiles.find((item) => item.id === id)
  if (!profile) throw new Error('No se encontró el streamer.')
  return profile
}

function dashboard() {
  return {
    profiles: profiles.map(sanitizeProfile),
    runtimes: Object.fromEntries(profiles.map((profile) => [profile.id, runtimeFor(profile.id)])),
  }
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dashboard:update', dashboard())
  }
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:update', updateState)
  }
}

function hasScheduledStream() {
  return [...runtimes.values()].some((runtime) => runtime.endAt || runtime.streaming)
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    setUpdateState({ status: 'disabled', message: 'Las actualizaciones se habilitan en la app instalada.' })
    return
  }

  const updateConfig = path.join(process.resourcesPath, 'app-update.yml')
  require('node:fs').access(updateConfig, require('node:fs').constants.R_OK, (error) => {
    if (error) {
      setUpdateState({ status: 'disabled', message: 'Esta compilación no tiene un canal de actualizaciones configurado.' })
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      setUpdateState({ status: 'checking', message: 'Buscando actualizaciones…' })
    })
    autoUpdater.on('update-available', (info) => {
      setUpdateState({ status: 'available', availableVersion: info.version, percent: 0, message: `Descargando versión ${info.version}…` })
    })
    autoUpdater.on('update-not-available', () => {
      setUpdateState({ status: 'up-to-date', availableVersion: '', percent: 0, message: 'Tenés la última versión.' })
    })
    autoUpdater.on('download-progress', (progress) => {
      setUpdateState({ status: 'downloading', percent: Math.round(progress.percent), message: `Descargando actualización: ${Math.round(progress.percent)}%` })
    })
    autoUpdater.on('update-downloaded', (info) => {
      setUpdateState({ status: 'ready', availableVersion: info.version, percent: 100, message: `La versión ${info.version} está lista para instalar.` })
    })
    autoUpdater.on('error', (error) => {
      setUpdateState({ status: 'error', message: `No se pudo comprobar la actualización: ${humanError(error)}` })
    })

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000)
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
  })
}

async function persistSchedules() {
  const schedules = {}
  for (const [id, runtime] of runtimes) {
    if (runtime.endAt) {
      schedules[id] = { startedAt: runtime.startedAt, endAt: runtime.endAt }
    }
  }
  await writeJson('schedules.json', schedules)
}

function humanError(error) {
  const message = error?.message || String(error)
  if (/ECONNREFUSED|Failed to connect|WebSocket/i.test(message)) {
    return 'No se pudo conectar con OBS. Revisá que esté abierto, que WebSocket esté activado y que el puerto sea correcto.'
  }
  return message
}

function parseArgs(value) {
  return (value.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((part) => part.replace(/^"|"$/g, ''))
}

async function linkOrCopyFile(source, target) {
  try {
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(source),
      fs.stat(target).catch(() => null),
    ])
    if (targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) return
    if (targetStat) await fs.unlink(target)
    try {
      await fs.link(source, target)
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error
      await fs.copyFile(source, target)
    }
  } catch (error) {
    throw new Error(`No se pudo preparar ${path.basename(source)}: ${error.message}`)
  }
}

async function ensureDirectoryJunction(source, target) {
  const existing = await fs.lstat(target).catch(() => null)
  if (existing?.isSymbolicLink()) return
  if (existing) await fs.rm(target, { recursive: true, force: true })
  await fs.symlink(source, target, 'junction')
}

async function linkObsRuntime(sourceRoot, targetRoot) {
  await fs.mkdir(targetRoot, { recursive: true })
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    if (name === 'config' || name === 'portable_mode' || name === 'portable_mode.txt') continue
    const source = path.join(sourceRoot, entry.name)
    const target = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) await ensureDirectoryJunction(source, target)
    else if (entry.isFile()) await linkOrCopyFile(source, target)
  }
}

async function cloneObsConfiguration(sourceConfig, targetConfig) {
  const ignoredTopLevel = new Set(['.sentinel', 'crashes', 'logs', 'profiler_data', 'updates'])
  await fs.cp(sourceConfig, targetConfig, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(sourceConfig, source).toLowerCase()
      if (!relative) return true
      const parts = relative.split(path.sep)
      if (ignoredTopLevel.has(parts[0])) return false
      if (parts[0] === 'plugin_config' && parts[1] === 'obs-websocket') return false
      return true
    },
  })
}

async function scoreObsConfiguration(configPath) {
  try {
    await fs.access(configPath)
    const scenes = await fs.readdir(path.join(configPath, 'basic', 'scenes'), { withFileTypes: true }).catch(() => [])
    const profilesFound = await fs.readdir(path.join(configPath, 'basic', 'profiles'), { withFileTypes: true }).catch(() => [])
    const sceneFiles = scenes.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    let configuredSourceCount = 0
    for (const sceneFile of sceneFiles) {
      try {
        const collection = JSON.parse(await fs.readFile(path.join(configPath, 'basic', 'scenes', sceneFile.name), 'utf8'))
        const sources = Array.isArray(collection.sources) ? collection.sources : []
        configuredSourceCount += sources.filter((source) => {
          if (source?.id !== 'scene') return true
          return Array.isArray(source?.settings?.items) && source.settings.items.length > 0
        }).length
      } catch {
        // Una colección dañada no debe impedir evaluar las demás.
      }
    }
    const sceneCount = sceneFiles.length
    const profileCount = profilesFound.filter((entry) => entry.isDirectory()).length
    return {
      configPath,
      sceneCount,
      configuredSourceCount,
      profileCount,
      score: configuredSourceCount * 10000 + sceneCount * 100 + profileCount * 10 + 1,
    }
  } catch {
    return null
  }
}

async function findBestObsConfiguration(sourceRoot, targetConfig) {
  const candidates = [
    path.join(sourceRoot, 'config', 'obs-studio'),
    path.join(app.getPath('appData'), 'obs-studio'),
  ]
  for (const savedProfile of profiles) {
    if (!savedProfile.obsExecutable || path.basename(savedProfile.obsExecutable).toLowerCase() !== 'obs64.exe') continue
    const savedRoot = path.resolve(path.dirname(savedProfile.obsExecutable), '..', '..')
    candidates.push(path.join(savedRoot, 'config', 'obs-studio'))
  }
  const instancesRoot = path.join(app.getPath('userData'), 'obs-instances')
  const instances = await fs.readdir(instancesRoot, { withFileTypes: true }).catch(() => [])
  for (const instance of instances) {
    if (instance.isDirectory()) {
      candidates.push(path.join(instancesRoot, instance.name, 'runtime', 'config', 'obs-studio'))
    }
  }

  const unique = [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
    .filter((candidate) => candidate.toLowerCase() !== path.resolve(targetConfig).toLowerCase())
  const scored = (await Promise.all(unique.map(scoreObsConfiguration))).filter(Boolean)
  scored.sort((left, right) => right.score - left.score)
  return scored[0] || null
}

async function prepareLightweightInstance(profile) {
  const executable = path.resolve(profile.obsExecutable)
  if (path.basename(executable).toLowerCase() !== 'obs64.exe') {
    throw new Error('Seleccioná el archivo obs64.exe de la instalación principal de OBS.')
  }
  const sourceRoot = path.resolve(path.dirname(executable), '..', '..')
  const sourceExecutable = path.join(sourceRoot, 'bin', '64bit', 'obs64.exe')
  await fs.access(sourceExecutable)

  const targetRoot = path.join(app.getPath('userData'), 'obs-instances', profile.id, 'runtime')
  const targetConfig = path.join(targetRoot, 'config', 'obs-studio')
  const cloneMarker = path.join(targetConfig, '.obs-manager-full-clone-v1')
  const markerExists = await fs.access(cloneMarker).then(() => true).catch(() => false)
  const targetState = await scoreObsConfiguration(targetConfig)
  const bestSource = await findBestObsConfiguration(sourceRoot, targetConfig)
  const targetIsEmpty = !targetState || targetState.configuredSourceCount === 0
  const shouldClone = !markerExists || (targetIsEmpty && bestSource?.configuredSourceCount > 0)

  if (shouldClone) {
    if (!bestSource || bestSource.configuredSourceCount === 0) {
      throw new Error('No se encontró ninguna configuración de OBS con fuentes configuradas. Seleccioná el obs64.exe del OBS original que funciona y volvé a conectar.')
    }
    try {
      await fs.mkdir(targetConfig, { recursive: true })
      await cloneObsConfiguration(bestSource.configPath, targetConfig)
      await fs.writeFile(cloneMarker, JSON.stringify({ clonedAt: new Date().toISOString(), source: bestSource.configPath }), 'utf8')
    } catch (error) {
      throw new Error(`No se pudo clonar la configuración original de OBS. Cerrá el OBS original e intentá nuevamente: ${error.message}`)
    }
  }
  await linkObsRuntime(sourceRoot, targetRoot)
  await fs.writeFile(path.join(targetRoot, 'portable_mode.txt'), '', { flag: 'a' })
  return path.join(targetRoot, 'bin', '64bit', 'obs64.exe')
}

async function resolveObsExecutable(profile) {
  if (profile.obsExecutable) {
    try {
      await fs.access(profile.obsExecutable)
      return profile.obsExecutable
    } catch {
      // Intentar detectar nuevamente una instalación estándar.
    }
  }

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'obs-studio', 'bin', '64bit', 'obs64.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'obs-studio', 'bin', '64bit', 'obs64.exe'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      profile.obsExecutable = candidate
      profile.updatedAt = new Date().toISOString()
      await writeJson('profiles.json', profiles)
      broadcast()
      return candidate
    } catch {
      // Probar la siguiente ubicación conocida.
    }
  }
  throw new Error('No se encontró obs64.exe. Abrí el perfil y seleccionalo con el botón Buscar.')
}

async function launchObs(profile) {
  const existing = launchedProcesses.get(profile.id)
  if (existing && !existing.killed) return

  let executable = await resolveObsExecutable(profile)
  let args = parseArgs(profile.obsArgs)
  if (profile.lightweightInstance) {
    executable = await prepareLightweightInstance(profile)
    args = args.filter((arg) => !['--portable', '-p'].includes(arg.toLowerCase()))
    if (!args.some((arg) => ['--multi', '-m'].includes(arg.toLowerCase()))) args.push('--multi')
    args.push('--portable')
  }

  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    detached: false,
    windowsHide: false,
    stdio: 'ignore',
  })
  child.once('error', (error) => {
    const runtime = runtimeFor(profile.id)
    runtime.state = 'error'
    runtime.error = `No se pudo abrir OBS: ${error.message}`
    broadcast()
  })
  child.once('exit', () => launchedProcesses.delete(profile.id))
  launchedProcesses.set(profile.id, child)
}

function attachClientEvents(profile, client) {
  client.on('ConnectionClosed', () => {
    clients.delete(profile.id)
    const runtime = runtimeFor(profile.id)
    runtime.state = runtime.streaming ? 'error' : 'offline'
    runtime.error = runtime.streaming ? 'Se perdió la conexión con OBS durante la transmisión.' : ''
    broadcast()
  })

  client.on('StreamStateChanged', async (event) => {
    const runtime = runtimeFor(profile.id)
    runtime.streaming = Boolean(event.outputActive)
    runtime.state = event.outputActive ? 'live' : 'ready'
    if (!event.outputActive) {
      runtime.startedAt = null
      runtime.endAt = null
      await persistSchedules()
    }
    broadcast()
  })

  client.on('CurrentProgramSceneChanged', (event) => {
    runtimeFor(profile.id).currentScene = event.sceneName || ''
    broadcast()
  })
}

async function openClient(profile) {
  const { default: OBSWebSocket } = await import('obs-websocket-js')
  const client = new OBSWebSocket()
  await client.connect(
    `ws://${profile.obsHost || '127.0.0.1'}:${profile.obsPort}`,
    decryptSecret(profile.obsPasswordEncrypted),
    { rpcVersion: 1 },
  )
  attachClientEvents(profile, client)
  clients.set(profile.id, client)
  return client
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function connectProfile(id) {
  const profile = profileFor(id)
  const runtime = runtimeFor(id)
  const connected = clients.get(id)
  if (connected) {
    await refreshRuntime(profile, connected)
    return runtime
  }

  runtime.state = 'connecting'
  runtime.error = ''
  broadcast()

  let client
  let lastError
  try {
    client = await openClient(profile)
  } catch (error) {
    lastError = error
  }

  if (!client && profile.autoLaunch) {
    await launchObs(profile)
    for (let attempt = 0; attempt < 20 && !client; attempt += 1) {
      await wait(750)
      try {
        client = await openClient(profile)
      } catch (error) {
        lastError = error
      }
    }
  }

  if (!client) {
    runtime.state = 'error'
    runtime.error = humanError(lastError)
    broadcast()
    throw new Error(runtime.error)
  }

  await refreshRuntime(profile, client)
  return runtime
}

async function refreshRuntime(profile, client) {
  const runtime = runtimeFor(profile.id)
  const [streamStatus, sceneList] = await Promise.all([
    client.call('GetStreamStatus'),
    client.call('GetSceneList'),
  ])
  runtime.streaming = Boolean(streamStatus.outputActive)
  runtime.state = runtime.streaming ? 'live' : 'ready'
  runtime.currentScene = sceneList.currentProgramSceneName || ''
  runtime.scenes = (sceneList.scenes || []).map((scene) => scene.sceneName).filter(Boolean)
  runtime.outputDuration = Number(streamStatus.outputDuration || 0)
  runtime.congestion = Number(streamStatus.outputCongestion || 0)
  runtime.skippedFrames = Number(streamStatus.outputSkippedFrames || 0)
  runtime.error = ''
  broadcast()
  return runtime
}

async function applyStreamSettings(profile, client) {
  const key = decryptSecret(profile.streamKeyEncrypted)
  if (!key) return

  const current = await client.call('GetStreamServiceSettings')
  let streamServiceType = current.streamServiceType
  const streamServiceSettings = { ...(current.streamServiceSettings || {}), key }

  if (profile.serviceType === 'rtmp_custom' && profile.server) {
    streamServiceType = 'rtmp_custom'
    streamServiceSettings.server = profile.server
    if (streamServiceSettings.use_auth == null) streamServiceSettings.use_auth = false
  } else if (!streamServiceType) {
    streamServiceType = 'rtmp_common'
    streamServiceSettings.service = profile.serviceName || profile.platform || 'Twitch'
  }

  if (!streamServiceSettings.server) {
    throw new Error('OBS no tiene un servidor de emisión configurado. Abrí Ajustes → Emisión en esa instancia y elegí un servidor antes de iniciar.')
  }

  await client.call('SetStreamServiceSettings', {
    streamServiceType,
    streamServiceSettings,
  })
}

async function startProfile(id, durationSeconds) {
  const profile = profileFor(id)
  const runtime = await connectProfile(id)
  const client = clients.get(id)
  if (!client) throw new Error('OBS no está conectado.')
  if (runtime.streaming) throw new Error('Este streamer ya está transmitiendo.')

  const seconds = Math.max(60, Math.min(Number(durationSeconds) || 3600, 7 * 24 * 3600))
  await applyStreamSettings(profile, client)
  if (profile.initialScene) {
    await client.call('SetCurrentProgramScene', { sceneName: profile.initialScene })
  }
  await client.call('StartStream')

  let status
  for (let attempt = 0; attempt < 30; attempt += 1) {
    status = await client.call('GetStreamStatus')
    if (status.outputActive) break
    await wait(250)
  }
  if (!status?.outputActive) throw new Error('OBS recibió la orden, pero no confirmó el inicio del stream.')

  const confirmedAt = Date.now()
  runtime.streaming = true
  runtime.state = 'live'
  runtime.startedAt = confirmedAt
  runtime.endAt = confirmedAt + seconds * 1000
  runtime.error = ''
  await persistSchedules()
  broadcast()
  return runtime
}

async function stopProfile(id) {
  if (stopping.has(id)) return runtimeFor(id)
  stopping.add(id)
  try {
    const profile = profileFor(id)
    const runtime = await connectProfile(id)
    const client = clients.get(id)
    if (client) {
      const status = await client.call('GetStreamStatus')
      if (status.outputActive) await client.call('StopStream')
    }
    runtime.streaming = false
    runtime.state = 'ready'
    runtime.startedAt = null
    runtime.endAt = null
    runtime.error = ''
    await persistSchedules()

    if (profile.closeAfterStop) {
      const child = launchedProcesses.get(id)
      if (child && !child.killed) child.kill()
    }
    broadcast()
    return runtime
  } catch (error) {
    const runtime = runtimeFor(id)
    runtime.state = 'error'
    runtime.error = `No se pudo detener el stream: ${humanError(error)}`
    broadcast()
    throw error
  } finally {
    stopping.delete(id)
  }
}

async function loadData() {
  profiles = await readJson('profiles.json', [])
  const schedules = await readJson('schedules.json', {})
  for (const profile of profiles) {
    const runtime = runtimeFor(profile.id)
    if (schedules[profile.id]) {
      runtime.startedAt = schedules[profile.id].startedAt
      runtime.endAt = schedules[profile.id].endAt
    }
  }
}

function registerIpc() {
  ipcMain.handle('dashboard:get', () => dashboard())

  ipcMain.handle('profile:save', async (_event, input) => {
    if (!input?.name?.trim()) throw new Error('El nombre del streamer es obligatorio.')
    const port = Number(input.obsPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('El puerto de OBS no es válido.')
    const duplicatePort = profiles.find((profile) => profile.id !== input.id && profile.obsPort === port)
    if (duplicatePort) {
      throw new Error(`El puerto ${port} ya está usado por ${duplicatePort.name}. Cada instancia local de OBS necesita un puerto diferente.`)
    }

    const existing = profiles.find((profile) => profile.id === input.id)
    const now = new Date().toISOString()
    const profile = {
      id: existing?.id || input.id || crypto.randomUUID(),
      name: input.name.trim(),
      platform: input.platform?.trim() || 'Twitch',
      obsHost: input.obsHost?.trim() || '127.0.0.1',
      obsPort: port,
      serviceType: input.serviceType === 'rtmp_custom' ? 'rtmp_custom' : 'rtmp_common',
      serviceName: input.serviceName?.trim() || input.platform?.trim() || 'Twitch',
      server: input.server?.trim() || '',
      initialScene: input.initialScene?.trim() || '',
      defaultDurationSeconds: Math.max(60, Number(input.defaultDurationSeconds) || 3600),
      obsExecutable: input.obsExecutable?.trim() || '',
      obsArgs: input.obsArgs?.trim() || '',
      lightweightInstance: Boolean(input.lightweightInstance),
      autoLaunch: Boolean(input.autoLaunch),
      closeAfterStop: Boolean(input.closeAfterStop),
      streamKeyEncrypted: input.streamKey ? encryptSecret(input.streamKey) : existing?.streamKeyEncrypted || '',
      obsPasswordEncrypted: input.obsPassword ? encryptSecret(input.obsPassword) : existing?.obsPasswordEncrypted || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }

    if (existing) profiles = profiles.map((item) => (item.id === existing.id ? profile : item))
    else profiles.push(profile)
    runtimeFor(profile.id)
    await writeJson('profiles.json', profiles)
    broadcast()
    return sanitizeProfile(profile)
  })

  ipcMain.handle('profile:delete', async (_event, id) => {
    if (runtimeFor(id).streaming) throw new Error('Detené el stream antes de borrar este perfil.')
    const client = clients.get(id)
    if (client) await client.disconnect().catch(() => {})
    clients.delete(id)
    profiles = profiles.filter((profile) => profile.id !== id)
    runtimes.delete(id)
    await Promise.all([writeJson('profiles.json', profiles), persistSchedules()])
    broadcast()
  })

  ipcMain.handle('obs:connect', (_event, id) => connectProfile(id))
  ipcMain.handle('obs:start', (_event, id, durationSeconds) => startProfile(id, durationSeconds))
  ipcMain.handle('obs:stop', (_event, id) => stopProfile(id))
  ipcMain.handle('obs:set-scene', async (_event, id, sceneName) => {
    const runtime = await connectProfile(id)
    await clients.get(id).call('SetCurrentProgramScene', { sceneName })
    runtime.currentScene = sceneName
    broadcast()
    return runtime
  })

  ipcMain.handle('dialog:obs-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar obs64.exe',
      properties: ['openFile'],
      filters: [{ name: 'OBS Studio', extensions: ['exe'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('updater:get-state', () => updateState)
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged || updateState.status === 'disabled') return updateState
    await autoUpdater.checkForUpdates()
    return updateState
  })
  ipcMain.handle('updater:install', () => {
    if (updateState.status !== 'ready') throw new Error('La actualización todavía no está lista.')
    if (hasScheduledStream()) throw new Error('Detené todos los streams antes de instalar la actualización.')
    appIsQuitting = true
    autoUpdater.quitAndInstall(false, true)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#090b10',
    title: 'OBS Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  mainWindow.on('close', (event) => {
    if (!appIsQuitting && hasScheduledStream()) {
      event.preventDefault()
      mainWindow.minimize()
    }
  })

  if (process.env.OBS_MANAGER_CAPTURE_PATH) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage()
        await fs.writeFile(path.resolve(process.env.OBS_MANAGER_CAPTURE_PATH), image.toPNG())
        app.quit()
      }, 800)
    })
  }
}

app.whenReady().then(async () => {
  await loadData()
  registerIpc()
  createWindow()
  setupAutoUpdater()

  setInterval(() => {
    const now = Date.now()
    for (const profile of profiles) {
      const runtime = runtimeFor(profile.id)
      if (runtime.endAt && runtime.endAt <= now && !stopping.has(profile.id)) {
        stopProfile(profile.id).catch(() => {})
      }
    }
  }, 500)

  setInterval(async () => {
    for (const profile of profiles) {
      const client = clients.get(profile.id)
      if (client) await refreshRuntime(profile, client).catch(() => {})
    }
  }, 5000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appIsQuitting = true
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
