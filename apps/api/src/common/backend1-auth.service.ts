import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config';

/**
 * Autenticación centralizada contra Backend 1 (Contabily).
 *
 * El accessToken de Contabily caduca cada 24h. Este servicio:
 *  - cachea el token vigente (inicializado desde BACKEND1_SHARED_TOKEN),
 *  - renueva vía POST /api/v1/auth/login cuando el backend responde 401,
 *  - reintenta la petición original una sola vez con el token nuevo,
 *  - persiste el token renovado en la env var de Render (si hay API key).
 *
 * Delegar acá evita que cada servicio maneje el ciclo de vida del token
 * (antes solo AssistantService lo hacía; EmpresasService fallaba en silencio
 * y el panel mostraba "No hay empresas en Backend 1").
 */
@Injectable()
export class Backend1AuthService {
  private readonly logger = new Logger(Backend1AuthService.name);
  private token: string;
  private refreshing: Promise<string | null> | null = null;

  constructor() {
    this.token = env.sharedToken();
  }

  /**
   * Base de las consultas de datos (asistente, reenvío de entrantes): el
   * servicio que expone /api/v1/contabilidad, /api/v1/clientes, etc.
   *
   * BACKEND1_BASE_URL tiene prioridad para poder separar ambos servicios en
   * el futuro. Si no está declarada se usa EMPRESAS_BACKEND_URL, que es la
   * URL que el panel ya necesita para listar empresas. Verificado contra
   * Contabily: ahí viven 12 de las 14 rutas que consulta el asistente, así
   * que en la configuración típica basta con declarar una sola variable.
   */
  get baseUrl(): string {
    return env.backend1BaseUrl() || env.empresasBackendUrl();
  }

  /**
   * Base del servicio Contabily. Usada para listar empresas del panel y para
   * el login de renovación de token.
   */
  get contabilyUrl(): string {
    return env.empresasBackendUrl() || env.backend1BaseUrl();
  }

  /**
   * Base para el login de renovación: si Contabily está declarado es el
   * servicio correcto; si no, backend 1 comparte la misma API de auth.
   */
  private get authUrl(): string {
    return this.contabilyUrl || this.baseUrl;
  }

  getToken(): string {
    return this.token || env.sharedToken();
  }

  /** Headers con Authorization (solo si hay token configurado). */
  authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    const token = this.token || env.sharedToken();
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * fetch con Authorization. Si Backend 1 responde 401, renueva el token
   * (single-flight: varias llamadas concurrentes comparten un solo login)
   * y reintenta la petición exacta una vez.
   */
  async fetchWithAuth(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await fetch(url, this.withAuthInit(init));
    if (response.status !== 401 || !this.authUrl) return response;

    const fresh = await this.refresh();
    if (!fresh) return response;
    // El reintento usa su propio presupuesto: el signal original ya puede
    // estar casi agotado tras el login, y no debe matar el reintento.
    return fetch(url, this.withAuthInit(this.withFreshTimeout(init)));
  }

  /** Reemplaza el signal por uno nuevo con presupuesto completo. */
  private withFreshTimeout(init: RequestInit): RequestInit {
    const timeoutMs = readTimeoutMs(init.signal);
    if (!timeoutMs) return init;
    const { signal: _old, ...rest } = init;
    return { ...rest, signal: AbortSignal.timeout(timeoutMs) };
  }

  private withAuthInit(init: RequestInit): RequestInit {
    const base = (init.headers ?? {}) as Record<string, string>;
    return { ...init, headers: this.authHeaders(base) };
  }

  /** Fuerza la renovación del token. Seguro de llamar en paralelo. */
  refresh(): Promise<string | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<string | null> {
    const base = this.authUrl;
    const email = process.env.CONTABILY_EMAIL;
    const password = process.env.CONTABILY_PASSWORD;

    if (!base) return null;
    if (!email || !password) {
      this.logger.warn(
        'CONTABILY_EMAIL o CONTABILY_PASSWORD no configurados: no se puede renovar el token',
      );
      return null;
    }

    try {
      this.logger.log('Renovando token de Backend 1 (login)...');
      const loginRes = await fetch(`${base.replace(/\/+$/, '')}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15000),
      });

      if (!loginRes.ok) {
        this.logger.warn(`Login en Backend 1 falló: HTTP ${loginRes.status}`);
        return null;
      }

      const data = (await loginRes.json()) as { tokens?: { accessToken?: string } };
      const newToken = data.tokens?.accessToken;
      if (!newToken) {
        this.logger.warn('Respuesta de login sin tokens.accessToken');
        return null;
      }

      this.token = newToken;
      // Se actualiza la env var para el resto del proceso (webhooks, etc.)
      process.env.BACKEND1_SHARED_TOKEN = newToken;
      await this.updateRenderToken(newToken);
      this.logger.log('Token de Backend 1 renovado');
      return newToken;
    } catch (err) {
      this.logger.warn(
        `No se pudo renovar el token de Backend 1: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async updateRenderToken(newToken: string): Promise<void> {
    const renderApiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;
    if (!renderApiKey || !serviceId) {
      this.logger.warn(
        'RENDER_API_KEY o RENDER_SERVICE_ID no configurados: el token renovado no persistirá tras el próximo deploy',
      );
      return;
    }

    try {
      const res = await fetch(
        `https://api.render.com/v1/services/${serviceId}/env-vars`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${renderApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ BACKEND1_SHARED_TOKEN: newToken }),
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(
          `No se pudo actualizar el token en Render: ${res.status} - ${err.slice(0, 200)}`,
        );
      } else {
        this.logger.log('Token actualizado en las env vars de Render');
      }
    } catch (err) {
      this.logger.warn(
        `Error actualizando el token en Render: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Diagnóstico paso a paso para el endpoint /api/health/backend1.
   * Permite distinguir "problema de red" de "token inválido" desde el
   * Shell de Render (curl http://localhost:PORT/api/health/backend1).
   */
  async diagnose(): Promise<{
    ok: boolean;
    baseUrl: string;
    contabilyUrl: string;
    pasos: Array<{ paso: string; ok: boolean; detalle: string }>;
  }> {
    const pasos: Array<{ paso: string; ok: boolean; detalle: string }> = [];
    const contabily = this.contabilyUrl;
    const data = this.baseUrl;

    const rawContabily = env.empresasBackendUrl();
    const rawData = env.backend1BaseUrl();
    const usaFallback = !rawData && !!rawContabily;

    pasos.push({
      paso: 'config',
      ok: !!contabily || !!data,
      detalle: [
        `EMPRESAS_BACKEND_URL=${rawContabily || '(sin configurar)'}`,
        rawData
          ? `BACKEND1_BASE_URL=${rawData}`
          : usaFallback
            ? 'BACKEND1_BASE_URL=(sin configurar, se reutiliza EMPRESAS_BACKEND_URL)'
            : 'BACKEND1_BASE_URL=(sin configurar)',
        `consultas del asistente -> ${data || '(sin destino)'}`,
      ].join(' · '),
    });
    if (!contabily && !data) return { ok: false, baseUrl: data, contabilyUrl: contabily, pasos };

    // 1) Login (prueba DNS + TLS + ruta de auth)
    const email = process.env.CONTABILY_EMAIL;
    const password = process.env.CONTABILY_PASSWORD;
    const loginBase = this.authUrl;
    let loginOk = false;
    const t0 = Date.now();
    try {
      const res = await fetch(
        `${loginBase.replace(/\/+$/, '')}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(15000),
        },
      );
      loginOk = res.status === 200;
      pasos.push({
        paso: 'login',
        ok: loginOk,
        detalle: `HTTP ${res.status} en ${Date.now() - t0}ms${res.ok ? '' : ` - ${(await res.text()).slice(0, 200)}`}`,
      });
    } catch (err) {
      pasos.push({
        paso: 'login',
        ok: false,
        detalle: `Fallo de red/DNS/TLS: ${(err as Error).message}`,
      });
    }

    // 2) /api/v1/empresas con el token vigente
    const t1 = Date.now();
    try {
      const res = await fetch(
        `${contabily.replace(/\/+$/, '')}/api/v1/empresas`,
        {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(15000),
        },
      );
      const body = await res.text();
      const cantidad = res.ok ? countRegistros(body) : null;
      pasos.push({
        paso: 'empresas (token vigente)',
        ok: res.ok,
        detalle: `HTTP ${res.status} en ${Date.now() - t1}ms${res.ok ? ` - ${cantidad} empresa(s)` : ` - ${body.slice(0, 200)}`}`,
      });
    } catch (err) {
      pasos.push({
        paso: 'empresas (token vigente)',
        ok: false,
        detalle: `Fallo de red/DNS/TLS: ${(err as Error).message}`,
      });
    }

    // 3) Renovación + reintento (el flujo real que usa el bot)
    const fresh = await this.refresh();
    if (fresh) {
      const t2 = Date.now();
      try {
        const res = await fetch(
          `${contabily.replace(/\/+$/, '')}/api/v1/empresas`,
          { headers: this.authHeaders(), signal: AbortSignal.timeout(15000) },
        );
        pasos.push({
          paso: 'empresas (tras renovar token)',
          ok: res.ok,
          detalle: `HTTP ${res.status} en ${Date.now() - t2}ms${res.ok ? ` - ${countRegistros(await res.text())} empresa(s)` : ''}`,
        });
      } catch (err) {
        pasos.push({
          paso: 'empresas (tras renovar token)',
          ok: false,
          detalle: `Fallo de red/DNS/TLS: ${(err as Error).message}`,
        });
      }
    } else {
      pasos.push({
        paso: 'empresas (tras renovar token)',
        ok: false,
        detalle: 'No se pudo renovar el token (login falló)',
      });
    }

    // 4) plan-cuentas: el endpoint que consulta el asistente. Con el
    // fallback puede apuntar a la misma base que el paso 2, pero se mantiene
    // porque valida la ruta concreta que usa el asistente, no solo la raíz.
    const t3 = Date.now();
    try {
      const res = await fetch(
        `${data.replace(/\/+$/, '')}/api/v1/contabilidad/plan-cuentas`,
        { headers: this.authHeaders(), signal: AbortSignal.timeout(15000) },
      );
      const body = await res.text();
      pasos.push({
        paso: 'consultas del asistente (plan de cuentas)',
        ok: res.ok,
        detalle: `HTTP ${res.status} en ${Date.now() - t3}ms${res.ok ? ` - ${countRegistros(body)} registro(s)` : ` - ${body.slice(0, 200)}`}`,
      });
    } catch (err) {
      pasos.push({
        paso: 'consultas del asistente (BACKEND1_BASE_URL)',
        ok: false,
        detalle: `Fallo de red/DNS/TLS: ${(err as Error).message}`,
      });
    }

    return {
      ok: pasos.every((p) => p.ok),
      baseUrl: data,
      contabilyUrl: contabily,
      pasos,
    };
  }
}

function countRegistros(body: string): number {
  try {
    const data = JSON.parse(body) as unknown;
    if (Array.isArray(data)) return data.length;
    const inner = (data as { data?: unknown }).data;
    return Array.isArray(inner) ? inner.length : 0;
  } catch {
    return 0;
  }
}

/** Extrae el presupuesto en ms de un signal de AbortSignal.timeout(). */
function readTimeoutMs(signal: AbortSignal | null | undefined): number | null {
  if (!signal || typeof signal !== 'object') return null;
  const deadline = (signal as { deadline?: unknown }).deadline;
  if (typeof deadline !== 'number') return null;
  const remaining = deadline - Date.now();
  return remaining > 0 ? remaining : null;
}
