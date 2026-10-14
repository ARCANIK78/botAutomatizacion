import { Backend1AuthService } from './backend1-auth.service';

const NEW_TOKEN = 'token-renovado';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Backend1AuthService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.EMPRESAS_BACKEND_URL = 'https://contabily.test';
    process.env.BACKEND1_SHARED_TOKEN = 'token-viejo';
    process.env.CONTABILY_EMAIL = 'nuevo@gmail.com';
    process.env.CONTABILY_PASSWORD = 'password-de-prueba';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.EMPRESAS_BACKEND_URL;
    delete process.env.BACKEND1_SHARED_TOKEN;
    delete process.env.CONTABILY_EMAIL;
    delete process.env.CONTABILY_PASSWORD;
  });

  it('reutiliza el token vigente cuando el backend responde 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Backend1AuthService();
    await service.fetchWithAuth('https://contabily.test/api/v1/empresas');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer token-viejo',
    );
  });

  it('renueva el token y reintenta una vez ante un 401', async () => {
    const fetchMock = jest
      .fn()
      // 1) petición original → 401 (token expirado)
      .mockResolvedValueOnce(jsonResponse({ message: 'expirado' }, 401))
      // 2) login → 200 con token nuevo
      .mockResolvedValueOnce(jsonResponse({ tokens: { accessToken: NEW_TOKEN } }))
      // 3) reintento → 200
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Backend1AuthService();
    const res = await service.fetchWithAuth('https://contabily.test/api/v1/empresas');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.getToken()).toBe(NEW_TOKEN);

    const [retryUrl, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(retryUrl).toBe('https://contabily.test/api/v1/empresas');
    expect((retryInit.headers as Record<string, string>).authorization).toBe(
      `Bearer ${NEW_TOKEN}`,
    );
  });

  it('sin credenciales no renueva y devuelve el 401 original', async () => {
    delete process.env.CONTABILY_EMAIL;
    delete process.env.CONTABILY_PASSWORD;

    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'expirado' }, 401));
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Backend1AuthService();
    const res = await service.fetchWithAuth('https://contabily.test/api/v1/empresas');

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('comparte un único login ante 401 concurrentes (single-flight)', async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/auth/login')) {
        return jsonResponse({ tokens: { accessToken: NEW_TOKEN } });
      }
      return jsonResponse({ message: 'expirado' }, 401);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new Backend1AuthService();
    await Promise.all([service.refresh(), service.refresh()]);

    const logins = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/login'),
    );
    expect(logins).toHaveLength(1);
  });
});
