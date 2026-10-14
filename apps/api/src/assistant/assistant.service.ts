import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { env } from '../config';
import { Backend1AuthService } from '../common/backend1-auth.service';
import { LlmMessage, LlmService, LlmTool } from './llm.service';

export interface AssistantInbound {
  id: string | null;
  from: string;
  fromNumber: string;
  body: string;
  timestamp: number;
  chatType: 'direct' | 'group';
  empresaId?: string;
}

const CONSULT_TOOL: LlmTool = {
  type: 'function',
  function: {
    name: 'consult_backend',
    description:
      'Consulta en el sistema contable (backend 1) los datos del usuario cuando la pregunta requiere información real: saldos, facturas, pagos, movimientos, clientes, etc. Devuelve la información para que redactes la respuesta final.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'La consulta a realizar sobre los datos del usuario, redactada de forma clara en español.',
        },
      },
      required: ['query'],
    },
  },
};

interface HistoryEntry {
  messages: LlmMessage[];
  at: number;
}

@Injectable()
export class AssistantService implements OnModuleDestroy {
  private readonly logger = new Logger(AssistantService.name);
  private readonly history = new Map<string, HistoryEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly llm: LlmService,
    private readonly backend1: Backend1AuthService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      env.chatHistoryTtlMs(),
    );
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  get enabled(): boolean {
    return this.llm.enabled;
  }

  async reply(payload: AssistantInbound): Promise<string | null> {
    if (!this.llm.enabled) return null;

    try {
      return await this.run(payload);
    } catch (err) {
      this.logger.error(
        `No se pudo generar la respuesta: ${(err as Error).message}`,
      );
      return env.fallbackReply();
    }
  }

  private get dataAvailable(): boolean {
    return env.backend1BaseUrl().length > 0;
  }

  private async run(payload: AssistantInbound): Promise<string> {
    const systemPrompt = this.dataAvailable
      ? env.llmSystemPrompt()
      : env.llmSystemPromptNoData();
    const tools = this.dataAvailable ? [CONSULT_TOOL] : [];

    const base: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.messagesFor(payload.fromNumber),
      { role: 'user', content: payload.body },
    ];

    const first = await this.llm.chat(base, tools);
    const consultCalls = first.toolCalls.filter(
      (call) => call.name === 'consult_backend',
    );

    let reply = first.content;

    if (consultCalls.length > 0) {
      const withAssistant: LlmMessage[] = [
        ...base,
        {
          role: 'assistant',
          content: first.content || null,
          tool_calls: consultCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      ];

      const toolResults: LlmMessage[] = [];
      for (const call of consultCalls) {
        const query = this.parseQuery(call.arguments, payload.body);
        const data = await this.consultBackend(query, payload);
        toolResults.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: data,
        });
      }

      const second = await this.llm.chat([...withAssistant, ...toolResults]);
      reply = second.content || reply;
    }

    const finalReply = reply.trim() || env.fallbackReply();

    this.remember(payload.fromNumber, [
      { role: 'user', content: payload.body },
      { role: 'assistant', content: finalReply },
    ]);

    return finalReply;
  }

  private parseQuery(rawArguments: string, fallback: string): string {
    try {
      const parsed = JSON.parse(rawArguments) as { query?: unknown };
      if (typeof parsed.query === 'string' && parsed.query.trim()) {
        return parsed.query.trim();
      }
    } catch {
      /* argumentos no-JSON: se usa el texto del usuario */
    }
    return fallback;
  }

  private async consultBackend(
    query: string,
    payload: AssistantInbound,
  ): Promise<string> {
    const base = this.backend1.baseUrl;
    if (!base) {
      this.logger.warn(
        'BACKEND1_BASE_URL sin configurar: no se puede consultar el sistema contable',
      );
      return env.dataUnavailableReply();
    }

    this.logger.log(`Base Backend 1: ${base}`);

    try {
      // Detectar qué endpoint consultar según la query
      const endpoint = this.detectEndpoint(query);
      if (!endpoint) {
        return 'No sé cómo consultar esa información. Pregunta por: plan de cuentas, clientes, productos, saldo, compras, gastos, proveedores, balance, etc.';
      }

      // Activar la empresa antes de consultar
      if (payload.empresaId) {
        await this.activateEmpresa(payload.empresaId);
      }

      const url = `${base.replace(/\/+$/, '')}${endpoint}`;
      this.logger.log(`Consultando ${endpoint} para query: ${query}`);

      // fetchWithAuth renueva el token y reintenta una vez si Backend 1 responde 401
      const res = await this.backend1.fetchWithAuth(url, {
        method: 'GET',
        signal: AbortSignal.timeout(env.backend1ReplyTimeoutMs()),
      });

      this.logger.log(`Response status: ${res.status} for ${endpoint}`);

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        this.logger.warn(`Backend 1 (${endpoint}) respondió HTTP ${res.status}: ${errorText.slice(0, 200)}`);
        return `El sistema de datos respondió HTTP ${res.status}. No fue posible obtener la información.`;
      }

      const data = await res.json();
      return this.formatResponse(endpoint, data);
    } catch (err) {
      this.logger.warn(
        `No se pudo consultar a backend 1: ${(err as Error).message}`,
      );
      return 'No se pudo contactar al sistema de datos. Informa al usuario que intente más tarde.';
    }
  }

  private async activateEmpresa(empresaId: string): Promise<void> {
    const base = this.backend1.baseUrl;
    if (!base) return;

    try {
      const url = `${base.replace(/\/+$/, '')}/api/v1/empresas/${empresaId}/activar`;
      const res = await this.backend1.fetchWithAuth(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        this.logger.warn(`No se pudo activar empresa ${empresaId}: HTTP ${res.status} - ${errorText.slice(0, 200)}`);
      } else {
        this.logger.log(`Empresa ${empresaId} activada correctamente`);
      }
    } catch (err) {
      this.logger.warn(`Error activando empresa ${empresaId}: ${(err as Error).message}`);
    }
  }

  private detectEndpoint(query: string): string | null {
    const q = query.toLowerCase();

    // Plan de cuentas
    if (q.includes('plan de cuentas') || q.includes('cuentas contables') || q.includes('plan contable')) {
      return '/api/v1/contabilidad/plan-cuentas';
    }
    if (q.includes('árbol de cuentas') || q.includes('arbol de cuentas')) {
      return '/api/v1/contabilidad/plan-cuentas/arbol';
    }
    if (q.includes('cuentas con saldo') || q.includes('saldos de cuentas')) {
      return '/api/v1/contabilidad/plan-cuentas/con-saldos';
    }

    // Balance / Estados financieros
    if (q.includes('balance de comprobación') || q.includes('balance comprobacion')) {
      return '/api/v1/contabilidad/balance-comprobacion';
    }
    if (q.includes('balance general') || q.includes('balance general')) {
      return '/api/v1/contabilidad/balance-general';
    }
    if (q.includes('estado de resultados') || q.includes('estado resultados') || q.includes('pérdidas y ganancias')) {
      return '/api/v1/contabilidad/estado-resultados';
    }
    if (q.includes('libro mayor')) {
      return '/api/v1/contabilidad/libro-mayor';
    }

    // Cajas / Saldos
    if (q.includes('saldo') || q.includes('caja') || q.includes('banco') || q.includes('cuentas financieras')) {
      return '/api/v1/cajas/cuentas';
    }

    // Clientes
    if (q.includes('cliente') || q.includes('clientes')) {
      return '/api/v1/clientes';
    }

    // Proveedores
    if (q.includes('proveedor') || q.includes('proveedores')) {
      return '/api/v1/proveedores';
    }

    // Productos / Inventario
    if (q.includes('producto') || q.includes('productos') || q.includes('inventario') || q.includes('stock')) {
      return '/api/v1/productos';
    }
    if (q.includes('resumen de inventario') || q.includes('resumen inventario')) {
      return '/api/v1/productos/resumen-inventario';
    }

    // Compras
    if (q.includes('compra') || q.includes('compras')) {
      return '/api/v1/compras';
    }

    // Gastos
    if (q.includes('gasto') || q.includes('gastos')) {
      return '/api/v1/gastos';
    }
    if (q.includes('categoría de gasto') || q.includes('categorias de gasto')) {
      return '/api/v1/gastos/categorias';
    }

    // Asientos / Contabilidad general
    if (q.includes('asiento') || q.includes('asientos')) {
      return '/api/v1/contabilidad/asientos';
    }

    return null;
  }

  private formatResponse(endpoint: string, data: unknown): string {
    if (!data) return 'No hay datos disponibles.';

    try {
      // Si es un array, formatear como lista
      if (Array.isArray(data)) {
        if (data.length === 0) return 'No hay registros.';
        
        // Limitar a 10 items para no saturar
        const items = data.slice(0, 10);
        const lines = items.map((item: any, i: number) => {
          // Extraer campos principales según el tipo de endpoint
          if (endpoint.includes('plan-cuentas')) {
            return `${i + 1}. ${item.codigo || ''} ${item.nombre || ''} ${item.tipo ? `(${item.tipo})` : ''} ${item.saldo !== undefined ? `- Saldo: ${item.saldo}` : ''}`;
          }
          if (endpoint.includes('clientes') || endpoint.includes('proveedores')) {
            return `${i + 1}. ${item.nombre || item.razonSocial || 'Sin nombre'} ${item.rif ? `- RIF: ${item.rif}` : ''} ${item.email ? `- ${item.email}` : ''}`;
          }
          if (endpoint.includes('productos')) {
            return `${i + 1}. ${item.nombre || item.sku || 'Sin nombre'} ${item.precio ? `- ${item.precio}` : ''} ${item.stock !== undefined ? `- Stock: ${item.stock}` : ''}`;
          }
          if (endpoint.includes('cajas/cuentas')) {
            return `${i + 1}. ${item.nombre || 'Sin nombre'} (${item.tipo || ''}) - Saldo: ${item.saldo !== undefined ? item.saldo : 'N/A'} ${item.moneda || ''}`;
          }
          if (endpoint.includes('compras') || endpoint.includes('gastos')) {
            return `${i + 1}. ${item.numeroFactura || item.numeroComprobante || item.id?.slice(0,8)} - ${item.fecha || ''} - ${item.monto || item.total || ''} ${item.moneda || ''}`;
          }
          // Genérico: mostrar primer campo que parezca nombre
          const name = item.nombre || item.razonSocial || item.titulo || item.descripcion || JSON.stringify(item).slice(0, 80);
          return `${i + 1}. ${name}`;
        });
        
        const more = data.length > 10 ? `\n... y ${data.length - 10} más` : '';
        return lines.join('\n') + more;
      }

      // Si es objeto, formatear campos principales
      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        const lines = Object.entries(obj)
          .filter(([_, v]) => v !== null && v !== undefined && v !== '')
          .slice(0, 15)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
        return lines.join('\n') || 'Datos recibidos (formato inesperado)';
      }

      return String(data);
    } catch (err) {
      this.logger.warn(`Error formateando respuesta: ${(err as Error).message}`);
      return JSON.stringify(data).slice(0, 1000);
    }
  }

  private extractData(text: string): string {
    if (!text) return 'El sistema de datos no devolvió información.';
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      for (const field of ['reply', 'data', 'message', 'result', 'answer']) {
        const value = json[field];
        if (typeof value === 'string') return value;
        if (value !== undefined && value !== null) {
          return JSON.stringify(value);
        }
      }
      return JSON.stringify(json);
    } catch {
      return text;
    }
  }

  private messagesFor(fromNumber: string): LlmMessage[] {
    const entry = this.history.get(fromNumber);
    if (!entry) return [];
    if (Date.now() - entry.at > env.chatHistoryTtlMs()) {
      this.history.delete(fromNumber);
      return [];
    }
    return entry.messages;
  }

  private remember(fromNumber: string, messages: LlmMessage[]): void {
    const entry = this.history.get(fromNumber);
    const previous = entry ? entry.messages : [];
    const merged = [...previous, ...messages].slice(-env.chatHistorySize());
    this.history.set(fromNumber, { messages: merged, at: Date.now() });
  }

  private cleanup(): void {
    const ttl = env.chatHistoryTtlMs();
    const now = Date.now();
    for (const [key, entry] of this.history) {
      if (now - entry.at > ttl) this.history.delete(key);
    }
  }
}
