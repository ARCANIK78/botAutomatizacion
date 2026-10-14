# botAutomatizacion

Bot de automatización de **WhatsApp** (backend puente + frontend de control) listo para desplegar en **Render** como un único servicio.

Flujo: **backend 1 (contable)** → `POST /webhooks/notify` → **backend 2 (este repo)** → mensaje al WhatsApp. Los mensajes entrantes se reenvían a backend 1 vía webhook.

La arquitectura completa y el estado de ejecución están documentados en [`PLAN.md`](./PLAN.md).

## Stack

- Monorepo npm workspaces (`apps/*`)
- `apps/api` — NestJS 11 + Baileys (@whiskeysockets/baileys) + pino + qrcode
- `apps/web` — React 19 + Vite 8 + TypeScript

## Requisitos

- Node.js **>= 20** (Baileys lo exige)

## Desarrollo

```bash
npm ci
npm run build        # compila api + web
npm run dev:api      # API en http://localhost:3000 (modo watch)
npm run dev:web      # frontend en http://localhost:5173 (proxy a la API)
```

Configuración de entorno: `cp apps/api/.env.example apps/api/.env` y ajusta los valores.

### Endpoints (API)

| Método | Ruta | Uso | Auth |
|---|---|---|---|
| GET | `/health` | Healthcheck (keep-alive) | — |
| GET | `/api/whatsapp/status` | Estado + QR (requiere admin token si `BACKEND2_ADMIN_TOKEN` está definido) | admin opcional |
| GET | `/api/whatsapp/qr` | QR como data-URL | `x-admin-token` / Bearer |
| POST | `/api/whatsapp/connect` | Generar/reconectar sesión | `x-admin-token` / Bearer |
| POST | `/api/whatsapp/send` | Enviar mensaje de prueba `{to, message}` | `x-admin-token` / Bearer |
| POST | `/webhooks/notify` | Backend 1 pide enviar `{to, message, idempotencyKey?}` | Bearer `BACKEND1_SHARED_TOKEN` |

Los mensajes entrantes se reenvían a `BACKEND1_BASE_URL + BACKEND1_INBOUND_PATH` cuando el primero está definido.

## Asistente conversacional (LLM)

Con `LLM_ENABLED=true` (o simplemente definiendo `LLM_API_KEY`), los mensajes
entrantes los responde un asistente con LLM:

1. El usuario escribe por WhatsApp.
2. El LLM decide si necesita datos del sistema contable.
3. Si los necesita, llama a la función `consult_backend`, que hace un `POST`
   síncrono a `{BACKEND1_BASE_URL}{BACKEND1_INBOUND_PATH}` con la consulta.
4. El LLM redacta la respuesta y el bot la envía al mismo chat.

Si el LLM o backend 1 fallan (timeout, `429`, caída), responde `FALLBACK_REPLY`.
Sin `LLM_API_KEY` el bot vuelve al modo simple (solo reenvío de entrantes).

Proveedor por defecto: **Groq free tier** (`openai/gpt-oss-20b`, sin costo, con
límites de uso). Es compatible con la API de OpenAI, así que puedes apuntar a
OpenRouter/Gemini cambiando `LLM_BASE_URL`, `LLM_API_KEY` y `LLM_MODEL`.

## Control de acceso

Por defecto el bot solo responde a **chats directos**. Si defines
`WHATSAPP_ALLOWED_NUMBERS` (lista separada por comas) o agregas números desde el
panel, únicamente responderá a esos números; los demás mensajes se **ignoran en
silencio**.

- Solo **números bolivianos de celular**: se normalizan a `591` + 8 dígitos
  (deben empezar en 6 o 7). Se aceptan `72830478`, `+591 72830478` o `59172830478`.
- `WHATSAPP_ALLOWED_NUMBERS` vacío y sin números en el panel → responde a cualquiera.
- `WHATSAPP_ALLOW_GROUPS=true` → permite también grupos (por defecto `false`).

### Gestión desde el panel
La tarjeta **Números autorizados** permite agregar/quitar números en caliente vía
`GET/POST/DELETE /api/whatsapp/allowed` (protegidos por token admin). Esa lista vive
en memoria: **se borra al reiniciar/redeploy**. Para que sea permanente, usa
`WHATSAPP_ALLOWED_NUMBERS` (esos aparecen con etiqueta `env` y no se pueden quitar
desde el panel).

Ideal mientras usas un número personal y aún no tienes un número dedicado. Cuando
exista backend 1, el filtro podrá validar clientes contra él (allowlist como respaldo).

## Variables de entorno

Ver [`apps/api/.env.example`](./apps/api/.env.example).

## Deploy en Render

Un único **Web Service**:

- **Build Command**: `npm ci && npm run build`
- **Start Command**: `npm run start:prod`
- **Root Directory**: `/`
- **Node Runtime**: 22+

Agregar las variables de `BACKEND1_*`, `BACKEND2_ADMIN_TOKEN` y `NODE_ENV=production`.

Recomendaciones para estabilidad:

1. **Persistent Disk** (1 GB) montado en `/data` → `WHATSAPP_SESSION_PATH=/data/auth`. Así la sesión sobrevive a redeploys y solo escaneas el QR una vez.
2. **Keep-alive externo** (UptimeRobot, Healthchecks.io, cron-job.org) con `GET /health` cada 1–5 min para evitar el *sleep* del free tier.
3. El bot reconecta solo con backoff exponencial (`WA_MAX_RECONNECT`); si la sesión se invalida, entra al panel y pulsa **Reconectar** para escanear un QR nuevo.

> El free tier se duerme sin tráfico y corta el WebSocket de WhatsApp; para conexión 24/7 considera un plan de pago o mantener el keep-alive activo.

### Renovación automática del token de Contabily

El `accessToken` de Contabily caduca cada 24 h. `Backend1AuthService` lo
renueva automáticamente: cuando Backend 1 responde `401`, hace login con
`CONTABILY_EMAIL`/`CONTABILY_PASSWORD`, reemplaza el token en memoria y
reintenta la petición original una sola vez. Aplica a `EmpresasService`
(listado del panel), el asistente y el reenvío de entrantes.

- **Importante**: las credenciales son las del **usuario de Contabily**, con el
  correo tal como está registrado (se respeta mayúsculas/minúsculas).
- Para que el token renovado sobreviva al próximo deploy, define
  `RENDER_API_KEY` y `RENDER_SERVICE_ID` (el bot hace un `PATCH` de
  `BACKEND1_SHARED_TOKEN` vía API de Render). Sin ellas, el token se renueva
  en caliente pero la env var vieja queda desactualizada.

### Diagnóstico de conectividad con Backend 1

Si el panel muestra **"No hay empresas en Backend 1"**, el problema suele ser
la red o el token. Para distinguirlos, desde el Shell de Render:

```bash
curl http://localhost:$PORT/api/health/backend1
```

El endpoint prueba por separado `login` (DNS/TLS/ruta) y `empresas` (token
vigente y token renovado), devolviendo el HTTP y el tiempo de cada paso.

## Notas

- La sesión de Baileys se guarda en `WHATSAPP_SESSION_PATH` (por defecto `./data/auth`, incluido en `.gitignore`).
- Riesgo de ban: usa un número dedicado y evita envíos masivos (integración no oficial).