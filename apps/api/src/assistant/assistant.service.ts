import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { env } from '../config';
import { LlmMessage, LlmService, LlmTool } from './llm.service';

export interface AssistantInbound {
  id: string | null;
  from: string;
  fromNumber: string;
  body: string;
  timestamp: number;
  chatType: 'direct' | 'group';
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

  constructor(private readonly llm: LlmService) {
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
    const base = env.backend1BaseUrl();
    if (!base) {
      return env.dataUnavailableReply();
    }

    const url = `${base.replace(/\/+$/, '')}${env.backend1InboundPath()}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = env.sharedToken();
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'query',
          query,
          from: payload.fromNumber,
          fromJid: payload.from,
          chatType: payload.chatType,
          timestamp: payload.timestamp,
        }),
        signal: AbortSignal.timeout(env.backend1ReplyTimeoutMs()),
      });

      if (!res.ok) {
        this.logger.warn(`Backend 1 respondió HTTP ${res.status}`);
        return `El sistema de datos respondió HTTP ${res.status}. No fue posible obtener la información.`;
      }

      const text = await res.text();
      return this.extractData(text);
    } catch (err) {
      this.logger.warn(
        `No se pudo consultar a backend 1: ${(err as Error).message}`,
      );
      return 'No se pudo contactar al sistema de datos. Informa al usuario que intente más tarde.';
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
