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

/**
 * Rutas disponibles en el sistema contable, en el orden en que se le
 * presentan al LLM. Cada una describe qué contiene, de modo que el modelo
 * elija según lo que pide el usuario y no según coincidencias de palabras.
 *
 * Antes el endpoint lo decidía detectEndpoint() con includes() sobre el
 * texto del usuario. Un saludo como "Activos" o "Inventarios" no menciona
 * ningún endpoint, así que todo caía en el plan de cuentas completo y el
 * asistente respondía igual a cualquier pregunta.
 */
interface RutaContable {
  id: string;
  ruta: string;
  descripcion: string;
}

const RUTAS_CONTABLES: RutaContable[] = [
  {
    id: 'plan-cuentas-arbol',
    ruta: '/api/v1/contabilidad/plan-cuentas/arbol',
    descripcion:
      'Plan de cuentas completo con su jerarquía real de subcuentas. Úsala para cualquier pregunta sobre el plan, las cuentas contables o una sección o cuenta concreta. Es la opción por defecto.',
  },
  {
    id: 'plan-cuentas-con-saldos',
    ruta: '/api/v1/contabilidad/plan-cuentas/con-saldos',
    descripcion:
      'Plan de cuentas con el saldo de cada cuenta (debe, haber, saldo deudor y acreedor). Úsala para preguntas por saldos de cuentas contables.',
  },
  {
    id: 'balance-comprobacion',
    ruta: '/api/v1/contabilidad/balance-comprobacion',
    descripcion: 'Balance de comprobación.',
  },
  {
    id: 'balance-general',
    ruta: '/api/v1/contabilidad/balance-general',
    descripcion: 'Balance general o estado de situación financiera.',
  },
  {
    id: 'estado-resultados',
    ruta: '/api/v1/contabilidad/estado-resultados',
    descripcion:
      'Estado de resultados, ingresos y gastos del periodo.',
  },
  {
    id: 'asientos',
    ruta: '/api/v1/contabilidad/asientos',
    descripcion: 'Asientos contables registrados.',
  },
  {
    id: 'cajas',
    ruta: '/api/v1/cajas/cuentas',
    descripcion:
      'Cuentas de caja y bancos con su saldo disponible. Úsala para preguntas por efectivo, caja, bancos o cuánto dinero hay disponible.',
  },
  {
    id: 'proveedores',
    ruta: '/api/v1/proveedores',
    descripcion: 'Proveedores registrados.',
  },
  {
    id: 'productos',
    ruta: '/api/v1/productos',
    descripcion:
      'Productos e inventario con precios y stock. Úsala para preguntas por productos o inventario.',
  },
  {
    id: 'resumen-inventario',
    ruta: '/api/v1/productos/resumen-inventario',
    descripcion: 'Resumen del inventario.',
  },
  {
    id: 'compras',
    ruta: '/api/v1/compras',
    descripcion: 'Compras realizadas.',
  },
  {
    id: 'gastos',
    ruta: '/api/v1/gastos',
    descripcion: 'Gastos registrados.',
  },
];

/**
 * Herramienta de consulta.
 *
 * El recurso se expone como enum de un solo campo en vez de como un
 * parámetro string por ruta. Con 12 parámetros opcionales libres el modelo
 * rellenaba uno al azar: "plan de cuentas" llegaba a resumen-inventario y
 * "saldos de cuentas" también. Un enum lo obliga a elegir un valor que
 * existe, y la selección entre valores enumerados es bastante más fiable que
 * rellenar texto libre en campos que no piden nada concreto.
 */
function buildConsultTool(): LlmTool {
  return {
    type: 'function',
    function: {
      name: 'consult_backend',
      description:
        'Consulta el sistema contable y devuelve los datos del usuario. Elige en "recurso" la opción que corresponda a lo que pide y explica en "query" qué buscar.',
      parameters: {
        type: 'object',
        properties: {
          recurso: {
            type: 'string',
            enum: RUTAS_CONTABLES.map((ruta) => ruta.id),
            description: [
              'Qué consultar. Opciones disponibles:',
              ...RUTAS_CONTABLES.map((ruta) => `- ${ruta.id}: ${ruta.descripcion}`),
            ].join('\n'),
          },
          query: {
            type: 'string',
            description:
              'Consulta a realizar sobre los datos del usuario, redactada de forma clara en español.',
          },
        },
        required: ['recurso', 'query'],
      },
    },
  };
}

const CONSULT_TOOL = buildConsultTool();

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

  /**
   * true si hay a dónde consultar. Cualquiera de las dos variables sirve:
   * en la configuración típica el servicio de datos y el de empresas es el
   * mismo y basta EMPRESAS_BACKEND_URL.
   */
  private get dataAvailable(): boolean {
    return this.backend1.baseUrl.length > 0;
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
        const { query, ruta } = this.parseToolCall(
          call.arguments,
          payload.body,
        );
        const data = await this.consultBackend(query, ruta, payload);
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

  /**
   * Lee los argumentos de la llamada y decide qué endpoint consultar.
   *
   * El LLM indica el recurso en el campo "recurso". Si no lo indica (o
   * indica uno que no existe) se usa el árbol de cuentas, que es la ruta
   * por defecto y cubre la mayoría de las preguntas sobre el plan.
   */
  private parseToolCall(
    rawArguments: string,
    fallback: string,
  ): { query: string; ruta: RutaContable } {
    const porDefecto = RUTAS_CONTABLES[0];
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      /* argumentos no-JSON: se usa la ruta por defecto */
    }

    const query =
      typeof parsed.query === 'string' && parsed.query.trim()
        ? parsed.query.trim()
        : fallback;

    const recurso =
      typeof parsed.recurso === 'string' ? parsed.recurso.trim() : '';
    const elegida = RUTAS_CONTABLES.find((ruta) => ruta.id === recurso);

    return { query, ruta: elegida ?? porDefecto };
  }

  private async consultBackend(
    query: string,
    ruta: RutaContable,
    payload: AssistantInbound,
  ): Promise<string> {
    const base = this.backend1.baseUrl;
    if (!base) {
      this.logger.warn(
        'Sin URL del sistema contable: no se puede consultar (BACKEND1_BASE_URL y EMPRESAS_BACKEND_URL sin definir)',
      );
      return env.dataUnavailableReply();
    }

    this.logger.log(`Base Backend 1: ${base}`);

    try {
      // Activar la empresa antes de consultar
      if (payload.empresaId) {
        await this.activateEmpresa(payload.empresaId);
      }

      const url = `${base.replace(/\/+$/, '')}${ruta.ruta}`;
      this.logger.log(`Consultando ${ruta.id} para query: ${query}`);

      // fetchWithAuth renueva el token y reintenta una vez si Backend 1 responde 401
      const res = await this.backend1.fetchWithAuth(url, {
        method: 'GET',
        signal: AbortSignal.timeout(env.backend1ReplyTimeoutMs()),
      });

      this.logger.log(`Response status: ${res.status} for ${ruta.id}`);

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        this.logger.warn(`Backend 1 (${ruta.id}) respondió HTTP ${res.status}: ${errorText.slice(0, 200)}`);
        return `El sistema de datos respondió HTTP ${res.status}. No fue posible obtener la información.`;
      }

      const data = await res.json();
      return this.formatResponse(ruta.ruta, data);
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

  /**
   * Máximo de registros que el asistente puede ver de una sola consulta.
   *
   * 150 filas planas son ~2-3k caracteres, que caben en el contexto sin
   * desplazar la conversación. Más allá de eso el prompt crece y el LLM
   * empieza a ignorar instrucciones. El límite anterior era 10, lo que
   * dejaba 39 de 49 cuentas fuera de la vista: el asistente no podía
   * buscarlas ni filtrarlas y respondía siempre con las mismas 10.
   */
  private static readonly MAX_FILAS = 150;

  /**
   * Aplana el árbol de cuentas respetando la jerarquía real que devolvió el
   * backend. La opción plan-cuentas es una lista plana cuyo padre está como
   * cuentaPadreId (un UUID), así que el LLM no puede reconstruirla y acaba
   * inventando la estructura. Acá la jerarquía viene resuelta.
   */
  private static aplanarArbol(nodos: any[], nivel = 0): string[] {
    const lineas: string[] = [];
    const sangria = '  '.repeat(nivel);
    for (const nodo of nodos) {
      if (!nodo || typeof nodo !== 'object') continue;
      const saldo =
        typeof nodo.neto === 'number' && nodo.neto !== 0
          ? ` (neto: ${nodo.neto})`
          : '';
      lineas.push(`${sangria}${nodo.codigo ?? ''} ${nodo.nombre ?? ''}${saldo}`);
      const hijos = Array.isArray(nodo.subCuentas) ? nodo.subCuentas : [];
      if (hijos.length > 0) {
        lineas.push(...AssistantService.aplanarArbol(hijos, nivel + 1));
      }
    }
    return lineas;
  }

  private formatResponse(endpoint: string, data: unknown): string {
    if (!data) return 'No hay datos disponibles.';

    try {
      // Si es un array, formatear como lista
      if (Array.isArray(data)) {
        if (data.length === 0) return 'No hay registros.';

        // El árbol viene anidado: se aplana antes de pasárselo al LLM
        const esArbol = endpoint.includes('plan-cuentas/arbol');
        if (esArbol) {
          const lineas = AssistantService.aplanarArbol(data);
          return lineas.length > 0
            ? lineas.join('\n')
            : 'El plan de cuentas no tiene cuentas registradas.';
        }

        const items = data.slice(0, AssistantService.MAX_FILAS);
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
            // gastos no trae numeroFactura: se usa la descripción como etiqueta
            const etiqueta =
              item.numeroFactura ||
              item.descripcion ||
              item.numeroComprobante ||
              item.categoria?.nombre ||
              (item.id ? String(item.id).slice(0, 8) : 'sin comprobante');
            const monto = item.total ?? item.monto ?? item.montoEnMonedaBase;
            return `${i + 1}. ${etiqueta} - ${item.fecha || ''} - ${monto ?? ''} ${item.moneda || ''}`.trim();
          }
          // Genérico: mostrar primer campo que parezca nombre
          const name = item.nombre || item.razonSocial || item.titulo || item.descripcion || JSON.stringify(item).slice(0, 80);
          return `${i + 1}. ${name}`;
        });

        const quedan = data.length - items.length;
        // Si quedaron registros fuera, se dice cuántos y cómo verlos. Decir
        // "... y 39 más" sin más instrucciones dejaba al LLM sin poder
        // responder a preguntas sobre esos 39.
        const more =
          quedan > 0
            ? `\n\n(Se muestran ${items.length} de ${data.length} registros. Hay ${quedan} más. Si el usuario pregunta por algo que no está aquí, vuelve a consultar indicando esa sección o palabra clave.)`
            : '';
        return lines.join('\n') + more;
      }

      // Si es objeto, formatear campos principales
      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;

        // El balance de comprobación trae las cuentas anidadas: volcar el
        // objeto entero sería JSON crudo con 23 cuentas dentro.
        if (Array.isArray(obj.cuentas) && obj.cuentas.length > 0) {
          const t = (obj.totales ?? {}) as Record<string, unknown>;
          const encabezado =
            typeof t.debe === 'number' || typeof t.haber === 'number'
              ? `Totales: debe ${t.debe ?? 0} · haber ${t.haber ?? 0}`
              : '';
          const filas = (obj.cuentas as any[])
            .slice(0, AssistantService.MAX_FILAS)
            .map(
              (c: any, i: number) =>
                `${i + 1}. ${c.codigo ?? ''} ${c.nombre ?? ''} - debe ${c.debe ?? 0} / haber ${c.haber ?? 0}`,
            );
          const cuadra =
            typeof obj.cuadra === 'boolean'
              ? `\n\nEl balance ${obj.cuadra ? 'cuadra' : 'NO cuadra'}.`
              : '';
          return [encabezado, ...filas, cuadra]
            .filter(Boolean)
            .join('\n');
        }

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
