import { useEffect, useMemo, useState } from 'react'
import type { DashboardData, ProfileInput, RuntimeState, StreamerProfile, UpdateState } from './types'

const emptyDashboard: DashboardData = { profiles: [], runtimes: {} }

const obsServiceName = (platform: string) => ({
  Twitch: 'Twitch',
  YouTube: 'YouTube - RTMPS',
  Facebook: 'Facebook Live',
  Kick: 'Kick',
}[platform] || platform)

const blankProfile = (port = 4455): ProfileInput => ({
  id: '',
  name: '',
  platform: 'Twitch',
  obsHost: '127.0.0.1',
  obsPort: port,
  serviceType: 'rtmp_common',
  serviceName: 'Twitch',
  server: '',
  initialScene: '',
  defaultDurationSeconds: 3600,
  obsExecutable: '',
  obsArgs: '--portable --multi',
  autoLaunch: true,
  closeAfterStop: false,
  streamKey: '',
  obsPassword: '',
})

function toInput(profile: StreamerProfile): ProfileInput {
  return { ...profile, streamKey: '', obsPassword: '' }
}

function formatRemaining(endAt: number | null, now: number) {
  if (!endAt) return '--:--:--'
  const total = Math.max(0, Math.ceil((endAt - now) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function stateLabel(runtime?: RuntimeState) {
  if (!runtime) return 'DESCONECTADO'
  return {
    offline: 'DESCONECTADO',
    connecting: 'CONECTANDO',
    ready: 'LISTO',
    live: 'EN VIVO',
    error: 'ERROR',
  }[runtime.state]
}

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function App() {
  const [data, setData] = useState<DashboardData>(emptyDashboard)
  const [now, setNow] = useState(Date.now())
  const [editor, setEditor] = useState<ProfileInput | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', currentVersion: '', availableVersion: '', percent: 0, message: '' })

  useEffect(() => {
    window.obsManager.getDashboard().then(setData).catch((error) => setNotice({ type: 'error', text: errorMessage(error) }))
    const unsubscribe = window.obsManager.onUpdate(setData)
    window.obsManager.getUpdateState().then(setUpdate).catch(() => {})
    const unsubscribeUpdater = window.obsManager.onUpdaterUpdate(setUpdate)
    const clock = window.setInterval(() => setNow(Date.now()), 500)
    return () => {
      unsubscribe()
      unsubscribeUpdater()
      window.clearInterval(clock)
    }
  }, [])

  useEffect(() => {
    setDurations((current) => {
      const next = { ...current }
      for (const profile of data.profiles) {
        if (!next[profile.id]) next[profile.id] = profile.defaultDurationSeconds
      }
      return next
    })
  }, [data.profiles])

  const liveCount = useMemo(
    () => data.profiles.filter((profile) => data.runtimes[profile.id]?.streaming).length,
    [data],
  )

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    setNotice(null)
    try {
      await action()
      if (success) setNotice({ type: 'success', text: success })
      setData(await window.obsManager.getDashboard())
    } catch (error) {
      setNotice({ type: 'error', text: errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const openNew = () => {
    const used = new Set(data.profiles.map((profile) => profile.obsPort))
    let port = 4455
    while (used.has(port)) port += 1
    setEditor(blankProfile(port))
  }

  const stopAll = async () => {
    const live = data.profiles.filter((profile) => data.runtimes[profile.id]?.streaming)
    if (!live.length || !window.confirm(`¿Detener las ${live.length} transmisiones activas?`)) return
    await run('stop-all', () => Promise.all(live.map((profile) => window.obsManager.stop(profile.id))), 'Se detuvieron todas las transmisiones.')
  }

  const updateControl = () => {
    if (update.status === 'ready') {
      return <button className="button update-ready" onClick={() => run('install-update', () => window.obsManager.installUpdate())}>↻ Reiniciar e instalar v{update.availableVersion}</button>
    }
    if (update.status === 'downloading' || update.status === 'available') {
      return <div className="update-progress" title={update.message}><span style={{ width: `${update.percent}%` }} /><b>{update.percent}%</b></div>
    }
    if (update.status === 'checking') return <div className="update-label">Buscando actualización…</div>
    if (update.status === 'error') return <button className="update-label error" title={update.message} onClick={() => window.obsManager.checkForUpdates()}>Reintentar actualización</button>
    return null
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div>
            <h1>OBS Manager</h1>
            <p>Centro de transmisiones</p>
          </div>
        </div>
        <div className="header-actions">
          {updateControl()}
          <div className={`live-summary ${liveCount ? 'active' : ''}`}>
            <span className="pulse" />
            {liveCount} {liveCount === 1 ? 'stream activo' : 'streams activos'}
          </div>
          {liveCount > 0 && (
            <button className="button danger ghost" onClick={stopAll} disabled={Boolean(busy)}>
              Detener todos
            </button>
          )}
          <button className="button primary" onClick={openNew}>+ Agregar streamer</button>
        </div>
      </header>

      <main>
        <section className="page-heading">
          <div>
            <span className="eyebrow">PANEL GENERAL</span>
            <h2>Tus transmisiones</h2>
            <p>Controlá cada instancia de OBS, sus escenas y el tiempo restante.</p>
          </div>
          <div className="capacity">
            <span>Capacidad recomendada</span>
            <strong>{liveCount} / 4</strong>
            <div><i style={{ width: `${Math.min(100, (liveCount / 4) * 100)}%` }} /></div>
          </div>
        </section>

        {notice && (
          <div className={`notice ${notice.type}`}>
            <span>{notice.type === 'error' ? '!' : '✓'}</span>
            <p>{notice.text}</p>
            <button onClick={() => setNotice(null)} aria-label="Cerrar">×</button>
          </div>
        )}

        {data.profiles.length === 0 ? (
          <section className="empty-state">
            <div className="empty-icon"><span /></div>
            <h3>Agregá tu primer streamer</h3>
            <p>Configurá su clave, puerto WebSocket, escena inicial y duración predeterminada.</p>
            <button className="button primary" onClick={openNew}>Crear primer perfil</button>
          </section>
        ) : (
          <section className="stream-grid">
            {data.profiles.map((profile) => {
              const runtime = data.runtimes[profile.id]
              const isLive = Boolean(runtime?.streaming)
              const cardBusy = busy.startsWith(`${profile.id}:`)
              const duration = durations[profile.id] || profile.defaultDurationSeconds
              return (
                <article className={`stream-card ${isLive ? 'is-live' : ''}`} key={profile.id}>
                  <div className="card-accent" />
                  <div className="card-header">
                    <div className="avatar">{profile.name.slice(0, 2).toUpperCase()}</div>
                    <div className="identity">
                      <h3>{profile.name}</h3>
                      <span>{profile.platform} · Puerto {profile.obsPort}</span>
                    </div>
                    <div className={`status status-${runtime?.state || 'offline'}`}>
                      <i /> {stateLabel(runtime)}
                    </div>
                  </div>

                  <div className="timer-panel">
                    <span>{isLive ? 'TIEMPO RESTANTE' : 'DURACIÓN DEL PRÓXIMO STREAM'}</span>
                    {isLive ? (
                      <strong>{formatRemaining(runtime?.endAt || null, now)}</strong>
                    ) : (
                      <div className="duration-inputs">
                        <label>
                          <input
                            type="number"
                            min="0"
                            max="168"
                            value={Math.floor(duration / 3600)}
                            onChange={(event) => setDurations({ ...durations, [profile.id]: Math.max(0, Number(event.target.value)) * 3600 + Math.floor((duration % 3600) / 60) * 60 })}
                          />
                          <small>horas</small>
                        </label>
                        <b>:</b>
                        <label>
                          <input
                            type="number"
                            min="0"
                            max="59"
                            value={Math.floor((duration % 3600) / 60)}
                            onChange={(event) => setDurations({ ...durations, [profile.id]: Math.floor(duration / 3600) * 3600 + Math.max(0, Math.min(59, Number(event.target.value))) * 60 })}
                          />
                          <small>minutos</small>
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="card-details">
                    <div><span>Escena</span><strong>{runtime?.currentScene || profile.initialScene || 'Sin definir'}</strong></div>
                    <div><span>Clave</span><strong>{profile.hasStreamKey ? 'Guardada y cifrada' : 'No configurada'}</strong></div>
                  </div>

                  {runtime?.scenes?.length > 0 && (
                    <label className="scene-picker">
                      <span>Cambiar escena</span>
                      <select
                        value={runtime.currentScene}
                        disabled={cardBusy}
                        onChange={(event) => run(`${profile.id}:scene`, () => window.obsManager.setScene(profile.id, event.target.value))}
                      >
                        {runtime.scenes.map((scene) => <option key={scene}>{scene}</option>)}
                      </select>
                    </label>
                  )}

                  {runtime?.error && <div className="card-error">{runtime.error}</div>}

                  <div className="card-actions">
                    {isLive ? (
                      <button
                        className="button danger grow"
                        disabled={cardBusy}
                        onClick={() => window.confirm(`¿Detener el stream de ${profile.name}?`) && run(`${profile.id}:stop`, () => window.obsManager.stop(profile.id), `Se detuvo el stream de ${profile.name}.`)}
                      >
                        {cardBusy ? 'Deteniendo…' : '■ Detener stream'}
                      </button>
                    ) : (
                      <>
                        <button
                          className="button secondary"
                          disabled={cardBusy}
                          onClick={() => run(`${profile.id}:connect`, () => window.obsManager.connect(profile.id), `${profile.name} está conectado con OBS.`)}
                        >
                          Conectar
                        </button>
                        <button
                          className="button live grow"
                          disabled={cardBusy || duration < 60}
                          onClick={() => run(`${profile.id}:start`, () => window.obsManager.start(profile.id, duration), `El stream de ${profile.name} está en vivo.`)}
                        >
                          {cardBusy ? 'Preparando…' : '● Iniciar stream'}
                        </button>
                      </>
                    )}
                    <button className="icon-button" onClick={() => setEditor(toInput(profile))} title="Editar perfil">•••</button>
                  </div>
                </article>
              )
            })}
          </section>
        )}
      </main>

      {editor && (
        <ProfileEditor
          value={editor}
          existing={Boolean(editor.id)}
          saving={busy === 'save-profile'}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={() => run('save-profile', async () => {
            await window.obsManager.saveProfile(editor)
            setEditor(null)
          }, 'Perfil guardado correctamente.')}
          onDelete={editor.id ? () => {
            if (!window.confirm(`¿Borrar el perfil de ${editor.name}?`)) return
            run('delete-profile', async () => {
              await window.obsManager.deleteProfile(editor.id)
              setEditor(null)
            }, 'Perfil eliminado.')
          } : undefined}
        />
      )}
    </div>
  )
}

interface EditorProps {
  value: ProfileInput
  existing: boolean
  saving: boolean
  onChange(value: ProfileInput): void
  onClose(): void
  onSave(): void
  onDelete?: () => void
}

function ProfileEditor({ value, existing, saving, onChange, onClose, onSave, onDelete }: EditorProps) {
  const set = <K extends keyof ProfileInput>(key: K, next: ProfileInput[K]) => onChange({ ...value, [key]: next })
  const hours = Math.floor(value.defaultDurationSeconds / 3600)
  const minutes = Math.floor((value.defaultDurationSeconds % 3600) / 60)

  const chooseExecutable = async () => {
    const selected = await window.obsManager.chooseObsExecutable()
    if (selected) set('obsExecutable', selected)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <header>
          <div>
            <span className="eyebrow">CONFIGURACIÓN</span>
            <h2 id="editor-title">{existing ? `Editar ${value.name}` : 'Nuevo streamer'}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
        </header>

        <div className="form-body">
          <div className="form-section">
            <h3>Identidad y transmisión</h3>
            <div className="form-grid two">
              <label><span>Nombre del streamer *</span><input value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="Ej. JuanGaming" autoFocus /></label>
              <label><span>Plataforma</span><select value={value.platform} onChange={(event) => {
                const platform = event.target.value
                onChange({
                  ...value,
                  platform,
                  serviceName: value.serviceType === 'rtmp_common' ? obsServiceName(platform) : value.serviceName,
                })
              }}><option>Twitch</option><option>YouTube</option><option>Kick</option><option>Facebook</option><option>Otra</option></select></label>
              <label className="full"><span>Clave de transmisión {existing && value.hasStreamKey ? '· ya guardada' : ''}</span><input type="password" value={value.streamKey || ''} onChange={(event) => set('streamKey', event.target.value)} placeholder={existing && value.hasStreamKey ? 'Dejar vacío para conservarla' : 'Ingresar stream key'} autoComplete="off" /></label>
              <label><span>Tipo de servicio</span><select value={value.serviceType} onChange={(event) => set('serviceType', event.target.value as ProfileInput['serviceType'])}><option value="rtmp_common">Servicio conocido</option><option value="rtmp_custom">Servidor RTMP personalizado</option></select></label>
              {value.serviceType === 'rtmp_common' ? (
                <label><span>Nombre reconocido por OBS</span><input value={value.serviceName} onChange={(event) => set('serviceName', event.target.value)} placeholder="Twitch" /></label>
              ) : (
                <label><span>URL del servidor RTMP *</span><input value={value.server} onChange={(event) => set('server', event.target.value)} placeholder="rtmp://servidor/app" /></label>
              )}
            </div>
          </div>

          <div className="form-section">
            <h3>Conexión con OBS</h3>
            <div className="form-grid three">
              <label><span>Host</span><input value={value.obsHost} onChange={(event) => set('obsHost', event.target.value)} /></label>
              <label><span>Puerto WebSocket</span><input type="number" value={value.obsPort} onChange={(event) => set('obsPort', Number(event.target.value))} /></label>
              <label><span>Contraseña {existing && value.hasObsPassword ? '· guardada' : ''}</span><input type="password" value={value.obsPassword || ''} onChange={(event) => set('obsPassword', event.target.value)} placeholder={existing && value.hasObsPassword ? 'Sin cambios' : 'Opcional'} /></label>
              <label className="full"><span>Ejecutable de OBS portable</span><div className="input-button"><input value={value.obsExecutable} onChange={(event) => set('obsExecutable', event.target.value)} placeholder="C:\\OBS-Streamer1\\bin\\64bit\\obs64.exe" /><button onClick={chooseExecutable}>Buscar</button></div></label>
              <label className="full"><span>Argumentos de inicio</span><input value={value.obsArgs} onChange={(event) => set('obsArgs', event.target.value)} placeholder="--portable --multi" /></label>
            </div>
          </div>

          <div className="form-section">
            <h3>Escena y automatización</h3>
            <div className="form-grid two">
              <label><span>Escena inicial</span><input value={value.initialScene} onChange={(event) => set('initialScene', event.target.value)} placeholder="Principal" /></label>
              <label><span>Duración predeterminada</span><div className="inline-duration"><input type="number" min="0" value={hours} onChange={(event) => set('defaultDurationSeconds', Number(event.target.value) * 3600 + minutes * 60)} /><small>h</small><input type="number" min="0" max="59" value={minutes} onChange={(event) => set('defaultDurationSeconds', hours * 3600 + Number(event.target.value) * 60)} /><small>min</small></div></label>
              <label className="check"><input type="checkbox" checked={value.autoLaunch} onChange={(event) => set('autoLaunch', event.target.checked)} /><span><strong>Abrir OBS automáticamente</strong><small>Si no está disponible al conectar</small></span></label>
              <label className="check"><input type="checkbox" checked={value.closeAfterStop} onChange={(event) => set('closeAfterStop', event.target.checked)} /><span><strong>Cerrar OBS al terminar</strong><small>Solo si la app abrió esa instancia</small></span></label>
            </div>
          </div>
        </div>

        <footer>
          {onDelete && <button className="button danger ghost" onClick={onDelete}>Eliminar perfil</button>}
          <div className="footer-spacer" />
          <button className="button secondary" onClick={onClose}>Cancelar</button>
          <button className="button primary" onClick={onSave} disabled={saving || !value.name.trim()}>{saving ? 'Guardando…' : 'Guardar perfil'}</button>
        </footer>
      </section>
    </div>
  )
}

export default App
