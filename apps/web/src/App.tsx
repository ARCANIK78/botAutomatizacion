import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ADMIN_TOKEN_KEY,
  addAllowed,
  fetchAllowed,
  fetchSessions,
  fetchStatus,
  fetchEmpresas,
  getAdminToken,
  reconnect,
  removeAllowed,
  removeSession,
  sendTest,
  type AllowlistEntry,
  type SessionInfo,
  type WaState,
  type WaStatus,
  type Empresa,
} from './api.ts'

const LABELS: Record<WaState, string> = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  waiting_for_qr: 'Esperando escaneo del QR',
  connected: 'Conectado',
}

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [empresas, setEmpresas] = useState<Empresa[]>([])
  const [selectedEmpresa, setSelectedEmpresa] = useState<string>('')
  const [status, setStatus] = useState<WaStatus | null>(null)
  const [persistedQr, setPersistedQr] = useState<string | null>(null) // QR que persiste hasta conectar/desconectar
  const [apiUp, setApiUp] = useState(true)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [token, setToken] = useState(getAdminToken())
  const [allowed, setAllowed] = useState<AllowlistEntry[]>([])
  const [newNumber, setNewNumber] = useState('')
  const logRef = useRef<HTMLUListElement>(null)

  const addLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()} — ${line}`])
  }, [])

  const refreshSessions = useCallback(async () => {
    const list = await fetchSessions()
    setSessions(list)
    return list
  }, [])

  const refreshEmpresas = useCallback(async () => {
    const list = await fetchEmpresas()
    setEmpresas(list)
    return list
  }, [])

  const refresh = useCallback(async () => {
    const next = await fetchStatus(selectedEmpresa || undefined)
    setApiUp(next !== null)
    if (next) {
      setStatus(next)
      // Persistir QR si está en waiting_for_qr y hay QR nuevo
      if (next.state === 'waiting_for_qr' && next.qr) {
        setPersistedQr(next.qr)
      }
      // Limpiar QR persistido si se conecta o desconecta
      if (next.state === 'connected' || next.state === 'disconnected') {
        setPersistedQr(null)
      }
    }
  }, [selectedEmpresa])

  const refreshAllowed = useCallback(async () => {
    try {
      setAllowed(await fetchAllowed(selectedEmpresa || undefined))
    } catch {
      setAllowed([])
    }
  }, [selectedEmpresa])

  useEffect(() => {
    void refreshSessions()
    void refreshEmpresas()
    void refresh()
    void refreshAllowed()
    const id = setInterval(() => void refresh(), 3000)
    return () => clearInterval(id)
  }, [refresh, refreshAllowed, refreshSessions, refreshEmpresas])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const onSelectEmpresa = (empresaId: string) => {
    setSelectedEmpresa(empresaId)
    // Limpiar QR persistido al cambiar de empresa (se recargará si hay uno nuevo)
    setPersistedQr(null)
    void refresh()
    void refreshAllowed()
  }

  // Poll para QR hasta que aparezca o falle - reintenta cada 30s si no se escanea
  const waitForQr = useCallback(async (empresaId: string, empresaNombre: string) => {
    setBusy(true)
    // Limpiar QR previo al iniciar nueva conexión
    setPersistedQr(null)
    addLog(`Iniciando sesión para ${empresaNombre}...`)

    const attemptConnection = async (): Promise<boolean> => {
      try {
        await reconnect(empresaId, empresaNombre)
        addLog(`Sesión iniciada, esperando QR...`)

        // Poll cada 1.5s hasta que haya QR o esté conectado (máx 30s)
        for (let i = 0; i < 20; i++) {
          
          await new Promise((r) => setTimeout(r, 1500))
          const st = await fetchStatus(empresaId)
          if (st) {
            setStatus(st)
            // Persistir QR cuando aparezca
            if (st.state === 'waiting_for_qr' && st.qr) {
              setPersistedQr(st.qr)
              addLog('¡QR listo! Escanea desde WhatsApp')
              return true // QR generado, esperar escaneo
            }
            if (st.state === 'connected') {
              addLog(`Conectado como ${st.user}`)
              void refreshSessions()
              return false // Conectado, terminar
            }
            if (st.state === 'disconnected') {
              addLog('Error: la sesión se desconectó')
              return false
            }
          }
        }
        // 30s pasaron sin que se escaneara el QR -> reintentar
        addLog('QR expirado (30s), generando uno nuevo...')
        return true // Reintentar
      } catch (err) {
        addLog(`Error: ${(err as Error).message}`)
        return false
      }
    }

    // Bucle de reintentos cada 30s hasta conectar o cancelar
    let shouldRetry = true
    while (shouldRetry) {
      shouldRetry = await attemptConnection()
      if (shouldRetry) {
        // Pequeña pausa antes de reintentar
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    setBusy(false)
  }, [addLog, refreshSessions])

  const onReconnect = useCallback(async () => {
    if (!selectedEmpresa) return
    const session = sessions.find((s) => s.empresaId === selectedEmpresa)
    await waitForQr(selectedEmpresa, session?.empresaNombre || selectedEmpresa)
  }, [selectedEmpresa, sessions, waitForQr])

  const onSend = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await sendTest(to, message, selectedEmpresa || undefined)
      addLog('Mensaje de prueba enviado')
      await refresh()
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [to, message, selectedEmpresa, sendTest, addLog, refresh])

  const onAddNumber = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      setAllowed(await addAllowed(newNumber, selectedEmpresa || undefined))
      addLog(`Número autorizado: ${newNumber}`)
      setNewNumber('')
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [newNumber, selectedEmpresa, addAllowed, addLog])

  const onRemoveNumber = useCallback(async (number: string) => {
    setBusy(true)
    try {
      setAllowed(await removeAllowed(number, selectedEmpresa || undefined))
      addLog(`Número quitado: ${number}`)
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [selectedEmpresa, removeAllowed, addLog])

  const onTokenChange = (value: string) => {
    setToken(value)
    localStorage.setItem(ADMIN_TOKEN_KEY, value)
    void refreshAllowed()
  }

  const state = status?.state ?? 'disconnected'
  const selectedSession = sessions.find((s) => s.empresaId === selectedEmpresa)

  return (
    <main className="shell">
      <header className="header">
        <h1>Bot WhatsApp</h1>
        <span className={`badge badge-${state}`}>{LABELS[state]}</span>
      </header>

      {!apiUp && (
        <p className="alert">No se pudo contactar a la API. ¿Está corriendo en el puerto 3000?</p>
      )}

      <section className="card">
        <h2>Empresas disponibles (Backend 1)</h2>
        {empresas.length === 0 ? (
          <p>No hay empresas en Backend 1. Crea una desde la API contable.</p>
        ) : (
          <div className="session-list">
            {empresas.map((e) => {
              const session = sessions.find((s) => s.empresaId === e.id)
              const isConnected = session?.state === 'connected'
              const isConnecting = session?.state === 'connecting' || session?.state === 'waiting_for_qr'
              const expectedPhone = e.telefono?.replace(/\D/g, '')
              const connectedPhone = session?.user ?? null
              const phoneMismatch = expectedPhone && connectedPhone && expectedPhone !== connectedPhone

              return (
                <div key={e.id} className="session-item-row">
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <span className="session-name">{e.nombre}</span>
                    {expectedPhone && (
                      <span className="hint" style={{ marginLeft: '8px' }}>
                        Tel. esperado: +{expectedPhone.replace(/(\d{2})(\d{2})(\d{4})(\d{4})/, '$1 $2 $3 $4')}
                      </span>
                    )}
                    {connectedPhone && (
                      <span className={`hint ${phoneMismatch ? 'error' : ''}`} style={{ marginLeft: '8px' }}>
                        Conectado: +{connectedPhone.replace(/(\d{2})(\d{2})(\d{4})(\d{4})/, '$1 $2 $3 $4')}
                        {phoneMismatch && ' ⚠️ NO COINCIDE'}
                      </span>
                    )}
                  </div>
                  {session ? (
                    <span className={`badge badge-${session.state}`}>{LABELS[session.state]}</span>
                  ) : (
                    <span className="badge badge-disconnected">Desconectado</span>
                  )}
                  <div className="session-actions">
                    {!isConnected && !isConnecting && (
                      <button
                        type="button"
                        onClick={() => { setSelectedEmpresa(e.id); waitForQr(e.id, e.nombre); }}
                        disabled={busy}
                      >
                        Conectar
                      </button>
                    )}
                    {isConnected && (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => { setSelectedEmpresa(e.id); waitForQr(e.id, e.nombre); }}
                          disabled={busy}
                        >
                          Reconectar
                        </button>
                        <button
                          type="button"
                          className="ghost danger"
                          onClick={async () => {
                            if (!confirm(`¿Desconectar ${e.nombre}? Se borrará la sesión de WhatsApp.`)) return
                            setBusy(true)
                            try {
                              await removeSession(e.id)
                              addLog(`Sesión de ${e.nombre} eliminada`)
                              setPersistedQr(null) // Limpiar QR al desconectar
                              void refreshSessions()
                              void refresh()
                            } catch (err) {
                              addLog(`Error: ${(err as Error).message}`)
                            } finally {
                              setBusy(false)
                            }
                          }}
                          disabled={busy}
                        >
                          Desconectar
                        </button>
                      </>
                    )}
                    {isConnecting && (
                      <button type="button" className="ghost" disabled>
                        Conectando…
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Sesiones activas</h2>
        {sessions.length === 0 ? (
          <p>No hay sesiones WhatsApp activas.</p>
        ) : (
          <div className="session-list">
            {sessions.map((s) => (
              <button
                key={s.empresaId}
                type="button"
                className={`session-item ${s.empresaId === selectedEmpresa ? 'active' : ''}`}
                onClick={() => onSelectEmpresa(s.empresaId)}
              >
                <span className="session-name">{s.empresaNombre}</span>
                <span className={`badge badge-${s.state}`}>{LABELS[s.state]}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Conexión {selectedSession ? `— ${selectedSession.empresaNombre}` : ''}</h2>
        <div className="card-content">
          {busy && state !== 'connected' && !persistedQr && (
            <div className="connecting-overlay">
              <div className="spinner" />
              <span>Generando código QR...</span>
            </div>
          )}
          {persistedQr ? (
            <div className="qr">
              <img src={persistedQr} alt="Código QR de WhatsApp" width={280} height={280} />
              <p>Escanea este código desde WhatsApp › Dispositivos vinculados</p>
              <p className="hint">El QR permanece visible hasta conectar o desconectar</p>
            </div>
          ) : state === 'waiting_for_qr' ? (
            <div className="connecting-overlay">
              <div className="spinner" />
              <span>Generando QR… por favor espera</span>
            </div>
          ) : state === 'connected' ? (
            <p className="ok">
              Sesión activa{status?.user ? `: ${status.user}` : ''}
            </p>
          ) : (
            <p>Sin sesión activa. Selecciona una empresa y pulsa "Conectar".</p>
          )}
          <button type="button" onClick={() => void onReconnect()} disabled={busy || !selectedEmpresa}>
            {busy ? 'Procesando…' : 'Reconectar'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Enviar mensaje de prueba</h2>
        <form onSubmit={(e) => void onSend(e)} className="form">
          <label>
            Destinatario
            <input
              value={to || '+591 '}
              onChange={(e) => {
                let val = e.target.value
                if (!val.startsWith('+591')) val = '+591 ' + val.replace(/[^0-9]/g, '')
                else val = '+591 ' + val.slice(5).replace(/[^0-9]/g, '')
                setTo(val)
              }}
              placeholder="+591 70000000"
              required
            />
          </label>
          <label>
            Mensaje
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Hola desde el bot"
              required
            />
          </label>
          <button type="submit" disabled={busy || !selectedEmpresa || state !== 'connected'}>
            Enviar
          </button>
        </form>
        <label className="token">
          Admin token
          <input
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="BACKEND2_ADMIN_TOKEN"
            type="password"
          />
        </label>
      </section>

      <section className="card">
        <h2>Números autorizados {selectedSession ? `— ${selectedSession.empresaNombre}` : ''}</h2>
        <p>
          {allowed.length === 0
            ? 'Lista vacía: el bot responde a todos los números.'
            : `Solo se responde a ${allowed.length} número(s).`}
        </p>
        <form className="inline" onSubmit={onAddNumber}>
          <input
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="72830478 o +591 72830478"
            inputMode="tel"
          />
          <button type="submit" disabled={busy || !newNumber.trim()}>
            Agregar
          </button>
        </form>
        {allowed.length > 0 && (
          <ul className="numbers">
            {allowed.map((entry) => (
              <li key={entry.number}>
                <span>
                  +{entry.number}
                  {entry.source === 'env' && <em className="tag">env</em>}
                </span>
                {entry.source === 'runtime' ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void onRemoveNumber(entry.number)}
                  >
                    Quitar
                  </button>
                ) : (
                  <span className="hint">fijo</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Solo números bolivianos (celular). Se borran al reiniciar; para fijarlos
          usa WHATSAPP_ALLOWED_NUMBERS.
        </p>
      </section>

      <section className="card">
        <h2>Actividad</h2>
        <ul className="log" ref={logRef}>
          {log.length === 0 ? <li>Sin actividad todavía</li> : log.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </section>
    </main>
  )
}