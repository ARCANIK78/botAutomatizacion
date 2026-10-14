import { AssistantService } from './assistant.service';
import type { LlmResult, LlmService } from './llm.service';
import type { InboundMessage } from '../whatsapp/whatsapp.service';
import { Backend1AuthService } from '../common/backend1-auth.service';

const payload: InboundMessage = {
  id: '1',
  from: '59170000000@s.whatsapp.net',
  fromNumber: '59170000000',
  body: '¿cuál es mi saldo?',
  timestamp: 1,
  chatType: 'direct',
};

function buildService(chat: jest.Mock, enabled = true): AssistantService {
  return new AssistantService(
    { enabled, chat } as unknown as LlmService,
    new Backend1AuthService(),
  );
}

describe('AssistantService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.BACKEND1_BASE_URL = 'https://backend1.test';
    process.env.BACKEND1_SHARED_TOKEN = 'secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LLM_API_KEY;
    delete process.env.BACKEND1_BASE_URL;
    delete process.env.BACKEND1_SHARED_TOKEN;
  });

  it('devuelve null cuando el LLM está desactivado', async () => {
    const service = buildService(jest.fn(), false);
    await expect(service.reply(payload)).resolves.toBeNull();
  });

  it('responde texto directo sin consultar backend 1', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: 'Hola, ¿en qué te ayudo?',
      toolCalls: [],
    } satisfies LlmResult);
    const service = buildService(chat);
    global.fetch = jest.fn();

    const reply = await service.reply(payload);
    expect(reply).toBe('Hola, ¿en qué te ayudo?');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('consulta backend 1 cuando el LLM pide datos', async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'c1', name: 'consult_backend', arguments: '{"query":"saldo"}' },
        ],
      } satisfies LlmResult)
      .mockResolvedValueOnce({
        content: 'Tu saldo es 100 Bs.',
        toolCalls: [],
      });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ data: { saldo: 100 } })),
    });

    const service = buildService(chat);
    const reply = await service.reply(payload);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(reply).toBe('Tu saldo es 100 Bs.');
  });

  it('devuelve el fallback si el LLM falla', async () => {
    process.env.FALLBACK_REPLY = 'Fallback de prueba';
    const chat = jest.fn().mockRejectedValue(new Error('boom'));
    const service = buildService(chat);
    const reply = await service.reply(payload);
    expect(reply).toBe('Fallback de prueba');
    delete process.env.FALLBACK_REPLY;
  });

  it('sin backend 1 no ofrece la herramienta y usa el prompt sin datos', async () => {
    delete process.env.BACKEND1_BASE_URL;
    delete process.env.EMPRESAS_BACKEND_URL;
    const chat = jest.fn().mockResolvedValue({
      content: '¡Hola! ¿En qué te ayudo?',
      toolCalls: [],
    } satisfies LlmResult);
    const service = buildService(chat);
    global.fetch = jest.fn();

    const reply = await service.reply(payload);

    expect(reply).toBe('¡Hola! ¿En qué te ayudo?');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, tools] = chat.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      unknown[],
    ];
    expect(tools).toEqual([]);
    expect(messages[0].content).toContain(
      'no podemos consultar con el servidor',
    );
  });

  it('sin backend 1 responde la frase estándar si piden datos', async () => {
    delete process.env.BACKEND1_BASE_URL;
    const chat = jest.fn().mockResolvedValue({
      content:
        'Actualmente no podemos consultar con el servidor, por favor inténtalo más tarde.',
      toolCalls: [],
    } satisfies LlmResult);
    global.fetch = jest.fn();
    const service = buildService(chat);

    const reply = await service.reply(payload);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(reply).toContain('no podemos consultar con el servidor');
  });

  it('ignora EMPRESAS_BACKEND_URL: solo BACKEND1_BASE_URL habilita el asistente', async () => {
    // Regresión: si baseUrl prefería EMPRESAS_BACKEND_URL, el asistente
    // seguía "habilitado" con esa base y construía URLs rotas para las
    // consultas de datos, respondiendo el mensaje genérico de error.
    process.env.EMPRESAS_BACKEND_URL = 'https://contabily.test';
    delete process.env.BACKEND1_BASE_URL;

    const chat = jest.fn().mockResolvedValue({
      content: '¡Hola! ¿En qué te ayudo?',
      toolCalls: [],
    } satisfies LlmResult);
    const service = buildService(chat);
    global.fetch = jest.fn();

    const reply = await service.reply(payload);

    expect(reply).toBe('¡Hola! ¿En qué te ayudo?');
    expect(global.fetch).not.toHaveBeenCalled();
    const [, tools] = chat.mock.calls[0] as [unknown, unknown[]];
    expect(tools).toEqual([]);
  });
});
