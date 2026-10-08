export type WaState = 'disconnected' | 'connecting' | 'waiting_for_qr' | 'connected'

export interface WaStatus {
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

export async function fetchStatus(): Promise<WaStatus | null> {
  try {
    const res = await fetch('/api/whatsapp/status', { headers: adminHeaders() })
    return await handle<WaStatus>(res)
  } catch {
    return null
  }
}

export async function reconnect(): Promise<void> {
  const res = await fetch('/api/whatsapp/connect', {
    method: 'POST',
    headers: adminHeaders(),
  })
  await handle(res)
}

export interface SendResult {
  ok: boolean
  to: string
}

export async function sendTest(to: string, message: string): Promise<SendResult> {
  const res = await fetch('/api/whatsapp/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ to, message }),
  })
  return await handle<SendResult>(res)
}

export interface AllowlistEntry {
  number: string
  source: 'env' | 'runtime'
}

export async function fetchAllowed(): Promise<AllowlistEntry[]> {
  const res = await fetch('/api/whatsapp/allowed', { headers: adminHeaders() })
  const body = await handle<{ numbers: AllowlistEntry[] }>(res)
  return body.numbers
}

export async function addAllowed(number: string): Promise<AllowlistEntry[]> {
  const res = await fetch('/api/whatsapp/allowed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders() },
    body: JSON.stringify({ number }),
  })
  const body = await handle<{ numbers: AllowlistEntry[] }>(res)
  return body.numbers
}

export async function removeAllowed(number: string): Promise<AllowlistEntry[]> {
  const res = await fetch(`/api/whatsapp/allowed/${encodeURIComponent(number)}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
  const body = await handle<{ numbers: AllowlistEntry[] }>(res)
  return body.numbers
}
