import { LlmError, LlmService } from './llm.service';

describe('LlmService', () => {
  const service = new LlmService();
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'https://example.test/v1';
    process.env.LLM_MODEL = 'test-model';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LLM_API_KEY;
  });

  function mockFetch(payload: unknown, status = 200) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    });
  }

  it('devuelve el contenido del asistente', async () => {
    mockFetch({ choices: [{ message: { content: 'Hola' } }] });
    const result = await service.chat([{ role: 'user', content: 'hola' }]);
    expect(result.content).toBe('Hola');
    expect(result.toolCalls).toEqual([]);
  });

  it('extrae las llamadas a funciones', async () => {
    mockFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: {
                  name: 'consult_backend',
                  arguments: '{"query":"saldo"}',
                },
              },
            ],
          },
        },
      ],
    });
    const result = await service.chat([{ role: 'user', content: 'saldo' }]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('consult_backend');
  });

  it('lanza LlmError con el código en respuestas no exitosas', async () => {
    mockFetch({ error: 'rate limit' }, 429);
    await expect(
      service.chat([{ role: 'user', content: 'hola' }]),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('lanza LlmError si no hay API key', async () => {
    delete process.env.LLM_API_KEY;
    await expect(
      service.chat([{ role: 'user', content: 'hola' }]),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
