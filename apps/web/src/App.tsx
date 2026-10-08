import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ADMIN_TOKEN_KEY,
  addAllowed,
  fetchAllowed,
  fetchStatus,
  getAdminToken,
  reconnect,
  removeAllowed,
  sendTest,
  type AllowlistEntry,
  type WaState,
  type WaStatus,
} from './api.ts'

const LABELS: Record<WaState, string> = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  waiting_for_qr: 'Esperando escaneo del QR',
  connected: 'Conectado',
}

export default function App() {
  const [status, setStatus] = useState<WaStatus | null>(null)
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

  const refresh = useCallback(async () => {
    const next = await fetchStatus()
    setApiUp(next !== null)
    if (next) setStatus(next)
  }, [])

  const refreshAllowed = useCallback(async () => {
    try {
      setAllowed(await fetchAllowed())
    } catch {
      setAllowed([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshAllowed()
    const id = setInterval(() => void refresh(), 3000)
    return () => clearInterval(id)
  }, [refresh, refreshAllowed])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const onReconnect = async () => {
    setBusy(true)
    try {
      await reconnect()
      addLog('Reconexión solicitada')
      await refresh()
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onSend = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await sendTest(to, message)
      addLog('Mensaje de prueba enviado')
      await refresh()
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onAddNumber = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      setAllowed(await addAllowed(newNumber))
      addLog(`Número autorizado: ${newNumber}`)
      setNewNumber('')
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onRemoveNumber = async (number: string) => {
    setBusy(true)
    try {
      setAllowed(await removeAllowed(number))
      addLog(`Número quitado: ${number}`)
    } catch (err) {
      addLog(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const onTokenChange = (value: string) => {
    setToken(value)
    localStorage.setItem(ADMIN_TOKEN_KEY, value)
    void refreshAllowed()
  }

  const state = status?.state ?? 'disconnected'

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
        <h2>Conexión</h2>
        {state === 'waiting_for_qr' && status?.qr ? (
          <div className="qr">
            <img src={status.qr} alt="Código QR de WhatsApp" width={260} height={260} />
            <p>Escanea este código desde WhatsApp › Dispositivos vinculados</p>
          </div>
        ) : state === 'waiting_for_qr' ? (
          <p>Generando QR… si no aparece, revisa que el token admin sea correcto.</p>
        ) : state === 'connected' ? (
          <p className="ok">
            Sesión activa{status?.user ? `: ${status.user}` : ''}
          </p>
        ) : (
          <p>Sin sesión activa. Pulsa reconectar para generar un QR nuevo.</p>
        )}
        <button type="button" onClick={() => void onReconnect()} disabled={busy}>
          {busy ? 'Procesando…' : 'Reconectar'}
        </button>
      </section>

      <section className="card">
        <h2>Enviar mensaje de prueba</h2>
        <form onSubmit={(e) => void onSend(e)} className="form">
          <label>
            Destinatario
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+59170000000"
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
          <button type="submit" disabled={busy || state !== 'connected'}>
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
        <h2>Números autorizados</h2>
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
