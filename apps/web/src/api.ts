export type WaState = 'disconnected' | 'connecting' | 'waiting_for_qr' | 'connected'

export interface WaStatus {
  state: WaState
  qr: string | null
  user: string | null
  at: number
}

export interface SessionInfo {
  empresaId: string
  empresaNombre: string
  state: WaState
  qr: string | null
  user: string | null
  at: number
}

export const ADMIN_TOKEN_KEY = 'bot_admin_token'

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
}

function adminHeaders(): HeadersInit {
  const token = getAdminToken()
  return token ? { 'x-admin-token': token } : {}
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`)
  }
  return body as T
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  try {
    const res = await fetch('/api/whatsapp/empresas', { headers: adminHeaders() })
    const body = await handle<{ sessions: SessionInfo[] }>(res)
    return body.sessions
  } catch {
    return []
  }
}

export async function fetchStatus(empresaId?: string): Promise<WaStatus | null> {
  try {
    const url = empresaId
      ? `/api/whatsapp/status?empresaId=${encodeURIComponent(empresaId)}`
      : '/api/whatsapp/status'
    const res = await fetch(url, { headers: adminHeaders() })
    return await handle<WaStatus>(res)
  } catch {
    return null
  }
}

export async function reconnect(empresaId?: string, empresaNombre?: string): Promise<void> {
  const res = await fetch('/api/whatsapp/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ empresaId, empresaNombre }),
  })
  await handle(res)
}

export interface SendResult {
  ok: boolean
  to: string
}

export async function sendTest(to: string, message: string, empresaId?: string): Promise<SendResult> {
  const res = await fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ to, message, empresaId }),
  })
  return await handle<SendResult>(res)
}

export interface AllowlistEntry {
  number: string
  source: 'env' | 'runtime'
}

export async function fetchAllowed(empresaId?: string): Promise<AllowlistEntry[]> {
  try {
    const url = empresaId
      ? `/api/whatsapp/allowed?empresaId=${encodeURIComponent(empresaId)}`
      : '/api/whatsapp/allowed'
    const res = await fetch(url, { headers: adminHeaders() })
    const body = await handle<{ numbers: AllowlistEntry[] }>(res)
    return body.numbers
  } catch {
    return []
  }
}

export async function addAllowed(number: string, empresaId?: string): Promise<AllowlistEntry[]> {
  const res = await fetch('/api/whatsapp/allowed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ number, empresaId }),
  })
  const body = await handle<{ numbers: AllowlistEntry[] }>(res)
  return body.numbers
}

export async function removeAllowed(number: string, empresaId?: string): Promise<AllowlistEntry[]> {
  const url = empresaId
    ? `/api/whatsapp/allowed/${encodeURIComponent(number)}?empresaId=${encodeURIComponent(empresaId)}`
    : `/api/whatsapp/allowed/${encodeURIComponent(number)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
  const body = await handle<{ numbers: AllowlistEntry[] }>(res)
  return body.numbers
}

export interface Empresa {
  id: string
  nombre: string
  telefono?: string
}

export async function fetchEmpresas(): Promise<Empresa[]> {
  try {
    const res = await fetch('/api/empresas', { headers: adminHeaders() })
    return await handle<Empresa[]>(res)
  } catch {
    return []
  }
}

export async function removeSession(empresaId: string): Promise<void> {
  const res = await fetch(`/api/whatsapp/session/${encodeURIComponent(empresaId)}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
  await handle(res)
}
