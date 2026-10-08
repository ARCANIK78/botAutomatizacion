# PLAN — botAutomatizacion (bot de automatización de WhatsApp)

> Recuperado de la sesión de opencode del 2026-10-07 (plan aprobado, la sesión se colgó en el paso 2).
> Estado actual: scaffold hecho (`apps/api` NestJS + `apps/web` Vite + workspaces). **Paso 3 en adelante pendiente.**

---

## Contexto / peticiones del usuario

**Petición inicial:**
> Necesitamos hacer un bot de automaticacion de whatsapp, la arquitectura es un backend y frontend de un sistema que toda via no esta completo, ah un segundo backend que consulta con el backend 1 y pueda mandar al celular alguna consulta

**Restricciones:**
> Con tal que pueda conectar el whatsapp que no tenga problemas con render todo bien enserio

> No hay presupuesto no imoprta que la seccion no dure puedes empezar

**Decisiones tomadas (vía preguntas):**
- Integración WhatsApp: **Baileys** (WhatsApp Web, QR, no oficial)
- Backend 1: existe en otro repo, **aún sin docs/URL** → contrato configurable
- Presupuesto: 0 → Render free tier + soluciones gratuitas

---

## Plan de arquitectura (bot WhatsApp automatizado)

Repo vacío. Vamos a construir **backend 2** + **frontend** aquí. Backend 1 existe en otro repo (aún sin docs/URL).

### Objetivos
- Recibir mensajes de WhatsApp y (cuando sepamos backend 1) reenviarlos o actuar según lógica.
- Enviar notificaciones salientes desde backend 1 hacia WhatsApp (a través de backend 2).
- Exponer UI mínima (QR, estado conexión) para escanear y monitorear.
- Desplegar en Render como **un solo web service**.

## 1) Integración WhatsApp
- **Opción elegida**: Baileys (WhatsApp Web, no oficial).
- **Motivo práctico**: gratis, QR, sin pasar por Meta Business approval inicial. Para MVP va bien.
- **Consideraciones**:
  - Riesgo de ban (usar con número dedicado, evitar spam).
  - Necesita mantener sesión (auth state). 
  - Requiere almacenamiento persistente de credenciales entre reinicios.

## 2) Stack tecnológico
- **Backend 2**: NestJS + TypeScript (estructura modular, DI, fácil para APIs + workers).
- **Frontend**: React + Vite (servido estáticamente por NestJS en un solo servicio).
- **WhatsApp**: @whiskeysockets/baileys
- **QR**: qrcode.react / qrcode-terminal (UI web para QR)
- **Persistencia sesión**: filesystem (carpeta `auth/` o `data/auth/`). No requiere BD relacional según solicitud ("solo sesión de Baileys").
- **Monorepo**: recomendado (apps/api, apps/web). Puede ser Nx, Turborepo o estructura simple con workspaces. Sencillo con npm workspaces + scripts.

## 3) Arquitectura general
```
[Frontend React (Vite)] ──(HTTP)── [NestJS API (Backend 2)] ──(Baileys)── WhatsApp Web
                                      │
                                      ├── POST /notify/send  (llamado por backend 1 para enviar)
                                      ├── POST /webhooks/inbound (recibe mensajes entrantes para reenviar a backend 1)
                                      ├── GET  /whatsapp/qr/status (estado + QR)
                                      └── Poller opcional / webhook receiver desde backend 1
```

Backend 1 (externo, contable) será quien consulte/solicite envíos. Backend 2 actúa como **puente WhatsApp**.

## 4) Comunicación backend1 <-> backend2
Tienes dudas entre polling/webhook. Te dejo explicación clara:

- **Webhook (recomendado)**: Backend 1 hace `POST https://tuapp.render.com/webhooks/notify` cuando tenga algo pendiente (ej. aviso de factura, cobro). Backend 2 valida token (shared secret) y envía mensaje a número que venga en payload.
- **Polling**: Backend 2 consulta `GET https://backend1.example/api/pending-notifications?since=...` cada N segundos. Sencillo si backend 1 aún no soporta webhooks.
- **Mi recomendación inicial**: **empezar con webhook** (push). Añadir polling como fallback configurable por env si backend 1 tarda en exponer webhooks.

**Contrato mínimo sugerido (flexible, hasta tener docs):**
```json
POST /webhooks/notify  (auth: Bearer <SHARED_TOKEN>)
{
  "to": "+59170000000",        // viene de datos backend1
  "message": "Texto plano",    // mensaje a enviar
  "idempotencyKey": "uuid"     // opcional para evitar dobles envíos
}
```

También necesitamos pensar cómo reenviar **mensajes entrantes** (usuario responde por WhatsApp). Dos opciones:
- Backend 2 recibe mensaje vía Baileys -> `POST` a backend 1 (`/webhooks/whatsapp-inbound`) con `{from, body, timestamp, ...}`. Backend 1 decide respuesta o deja en bandeja.
- Si backend 1 no tiene webhook aún, guardamos logs temporales hasta definir.

## 5) Persistencia
Solo sesión Baileys. Propuesta:
- Carpeta `./data/auth/` (ignorada por git). Contiene estado de conexión (creds, keys).
- En Render **free** el filesystem es efímero (se borra en redeploy/restart). Si queremos mantener sesión entre reinicios, **necesitamos Render Disk** (pago) montado en `/opt/data` o `/data`. 
- Alternativas: Upstash Redis + baileys auth storage adapter, o simplemente aceptar que tras restart hay que escanear QR otra vez (aceptable para MVP).
- **Recomendación**: empezar con filesystem local; añadir nota para configurar disk en Render si queremos persistencia.

## 6) Estructura de carpetas propuesta (monorepo)
```
botAutomatizacion/
├── apps/
│   ├── api/        # NestJS (backend 2)
│   │   ├── src/
│   │   │   ├── whatsapp/  (Baileys service, connection manager)
│   │   │   ├── webhooks/  (recibe notify desde backend1 + inbound)
│   │   │   ├── admin/     (QR/status)
│   │   │   └── app.module.ts
│   └── web/        # React + Vite (SPA)
├── packages/
│   └── shared/     # tipos compartidos (payloads) si necesario
├── data/           # auth + tmp (gitignored)
├── package.json    # workspaces
└── README.md
```

## 7) Endpoints mínimos (backend 2)
| Método | Ruta | Uso | Auth |
|---|---|---|---|
| GET | `/`/health o `/api/health` | healthcheck Render | público |
| GET | `/whatsapp/qr` (o `/admin/whatsapp/qr.png`) | obtener QR actual (dataURL o imagen) | protegido (simple token/header) |
| GET | `/whatsapp/status` | connected/connecting/disconnected/qr | protegido |
| POST | `/webhooks/notify` | backend 1 pide enviar mensaje | `Authorization: Bearer SHARED_TOKEN` |
| POST | `/webhooks/whatsapp-inbound` | (opcional) recibir entrantes si no reenvía directo | interno o tokenizado |
| POST | `/admin/whatsapp/connect` | forzar reconexión (útil tras restart) | protegido |

## 8) Frontend mínimo
Página simple:
- Estado: Desconectado / Conectando / Conectado
- QR visible cuando "esperando escaneo"
- Botón "Actualizar QR" / "Reconectar"
- Mostrar número conectado (si disponible)
- (dev) formulario test send: `to` + `message` (solo para validar).

Servido por NestJS: `app.useStaticAssets('dist/web')` + fallback a `index.html`.

## 9) Variables de entorno (backend 2)
| Var | Valor | Notas |
|---|---|---|
| `PORT` | 3000 | Render lo inyecta |
| `NODE_ENV` | production | |
| `WHATSAPP_SESSION_PATH` | ./data/auth | ruta persistente |
| `BACKEND1_BASE_URL` | https://backend1... | aún desconocido |
| `BACKEND1_SHARED_TOKEN` | secret | auth entre backends |
| `BACKEND2_ADMIN_TOKEN` | secret | proteger endpoints admin/QR |
| `POLL_INTERVAL_MS` | 30000 | si activamos polling |
| `ENABLE_POLLING` | false | empezar sin polling |

## 10) Deploy en Render (un solo web service)
Config sugerida:
- **Type**: Web Service
- **Runtime**: Node
- **Build Command**: `npm ci && npm run build` (construye api+web)
- **Start Command**: `npm run start:prod` (levanta NestJS)
- **Root Directory**: `/` (raíz repo)
- **Env**: agregar las vars anteriores
- **Disk** (opcional pero recomendado): crear disk 1GB montado en `/data` -> set `WHATSAPP_SESSION_PATH=/data/auth`

**Notas Render:**
- Free tier se duerme tras inactividad (afecta conexión Baileys). Para mantener conectado mejor paid o tener keep-alive externo.
- QR solo se muestra mientras no hay sesión válida; tras reconexión exitosa persiste.
- Puerto debe usar `process.env.PORT`.

## 11) Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Ban WhatsApp (Baileys no oficial) | Usar número dedicado, evitar automatizaciones masivas, respetar rate limits. |
| Sesión se pierde en restart (free tier) | Configurar Render Disk o documentar reescaneo QR. |
| Backend 1 cambia contrato | Mantener adapter/service para transformar payloads (interfaz `INotificationProvider`). |
| Conexión se cae | Implementar auto-reconnect + healthcheck + UI para reconectar. |
| Autenticación débil entre backends | Usar `Authorization: Bearer` + shared secret + idempotency keys. |

## 12) Plan de trabajo (paso a paso)
1. **Aprobar plan** (este documento) + aclarar dudas pendientes si las hay.
2. **Scaffold monorepo**: NestJS (api) + Vite (web) + workspaces. Configurar build que empaquete web en api.
3. **Integrar Baileys**: connection manager, auth state con filesystem, eventos (qr, connected, disconnected).
4. **API mínima**: health, whatsapp status/qr, webhook notify, admin endpoints con auth.
5. **Frontend QR+status**: conectar a API, mostrar QR, refrescar estado.
6. **Reenvío inbound**: enviar mensajes entrantes a backend 1 (cuando tengamos URL/token).
7. **Config + README**: env.example, instrucciones Render + QR.
8. **Test local**: escanear QR, enviar mensaje test, recibir respuesta.
9. **Deploy Render**: configurar vars + disk + validar.

**Dudas para cerrar antes de empezar (opcional):**
- ¿Quieres que proteja también `/webhooks/notify` con IP allowlist además del token? 
- ¿Tienes pensado algún endpoint concreto de backend 1 para recibir inbound? (aunque aún no lo tengas, lo dejamos configurable)
- ¿Prefieres que backend 2 exponga `/api/*` prefix o rutas planas como propongo?

Dime si este plan te parece bien. Si lo apruebas, **no haré cambios aún** (sigo en modo plan) pero puedo refinarlo con detalles extra.


---

# Ajuste aprobado: estabilidad en Render

Te dejo un **ajuste mínimo del plan** para asegurar que WhatsApp se conecte y no tengas problemas con Render.

## 1) Persistencia de la sesión (clave para no reescanear QR)

Baileys guarda todas las credenciales en el filesystem. El problema en Render es que el disco efímero se borra en cada `restart/redeploy`.

**Solución**: usar **Render Persistent Disk** montado en `/data`.

- Montar disco (1GB mínimo) en `/data` en Render
- Configurar `WHATSAPP_SESSION_PATH=/data/auth`
- Así la sesión sobrevive a reinicios y despliegues. Solo tendrás que escanear QR **la primera vez**.

**Sin Disk (free tier)**: funciona, pero tras cada reinicio se pierde la sesión y **hay que volver a escanear el QR**. Para MVP puede aceptarse, pero para que quede estable lo ideal es el Disk.

## 2) Evitar el "sleep" de Render Free

Los **Web Services gratuitos** de Render se duermen después de ~15 minutos sin tráfico. Como Baileys mantiene un WebSocket largo con WhatsApp Web, ese sleep corta la conexión.

**Opciones**:

- **Keep-alive externo (recomendado y gratis)**: usar [UptimeRobot](https://uptimerobot.com/), [Healthchecks.io](https://healthchecks.io/) o [cron-job.org](https://cron-job.org/es) para hacer un `GET` a `/health` cada 1–5 minutos. Esto mantiene el servicio activo y evita el sleep en la mayoría de casos.
- **Plan de pago en Render**: no tiene sleep. Si necesitas que esté **conectado 24/7 sin depender de keep-alive**, lo mejor es un plan pago.

**Conclusión**: Con **keep-alive externo + auto-reconnect** te funciona bien en free tier.

## 3) Auto-reconnect (imprescindible)

Aunque Baileys maneja reconexiones, hay que asegurar que el `ConnectionManager` escuche `connection.update` y haga **reconexión automática con backoff exponencial** cuando caiga la conexión (red, sleep, timeout...). Esto evita quedarte desconectado y que no vuelva solo.

## 4) Healthcheck para monitoreo

Añadimos `GET /health` devolviendo estado real de WhatsApp (`connected | connecting | disconnected | waiting_for_qr`). Útil para el keep-alive y para saber el estado desde el frontend.

## 5) Ajustes de variables de entorno

| Var | Valor sugerido | Notas |
|---|---|---|
| `PORT` | (Render lo inyecta) | Obligatorio usar `process.env.PORT` |
| `WHATSAPP_SESSION_PATH` | `/data/auth` | Con Render Disk. Si no usas disk: `./data/auth` |
| `NODE_ENV` | `production` | Estable para Render |

## Veredicto

**Sí, puedes conectar WhatsApp sin problemas en Render.** Las 3 condiciones para que quede estable:

1. **Render Persistent Disk** para conservar la sesión (evita reescanear QR constantemente)
2. **Keep-alive externo** (free tier) o **plan pago** (sin sleep)
3. **Auto-reconnect robusto** en backend 2

Con esos tres puntos cumplidos, el requisito de "que no tenga problemas con Render" queda cubierto. El resto del plan anterior queda válido tal como lo propusimos.


---

# Estado de ejecución (checklist)

- [x] 1. Aprobar plan
- [x] 2. Scaffold monorepo: `apps/api` (NestJS) + `apps/web` (Vite + **React**) + npm workspaces + build raíz
- [x] 3. Integrar Baileys: connection manager, auth state en filesystem, eventos `qr` / `connection.update`, auto-reconnect con backoff
- [x] 4. API mínima: `/health`, `/api/whatsapp/status`, `/api/whatsapp/qr`, `/api/whatsapp/connect`, `/api/whatsapp/send`, `/webhooks/notify` (Bearer + idempotencia), admin con token
- [x] 5. Frontend React: estado + QR + botón reconectar + envío de prueba (servido desde NestJS)
- [ ] 6. Reenvío inbound → backend 1 (URL/token aún pendientes, configurable vía `BACKEND1_BASE_URL`)
- [x] 7. Config + README: `.env.example`, `.gitignore` raíz, README con instrucciones Render
- [ ] 8. Test local: escanear QR, enviar mensaje de prueba, recibir respuesta
- [ ] 9. Deploy en Render (disk + vars + keep-alive)

**Pendiente desde el inicio:**
- `apps/web` migrado a React (el plan lo pedía; antes quedó Vite vanilla TS)
- Nombre de paquetes `api`/`web` (podrían renombrarse a `backend`/`frontend` si se prefiere)
- Decidir protección del panel (por defecto: sin token en dev, `BACKEND2_ADMIN_TOKEN` en producción)

---

## Registro de sesiones (historial)

### Sesión 2 — 2026-10-07 (implementación, pasos 2–5)

**Decisiones tomadas**
- `apps/web` migrado de Vite vanilla TS a **React 19 + Vite 8** (el plan original pedía React).
- Prefijo final de rutas: **`/api/...`** para admin+status, `/webhooks/...` planos para backend 1 (se resolvió la duda abierta del plan).
- Baileys: **@whiskeysockets/baileys 6.7.24** (rama legacy estable, ESM; se importa con `await import(...)` para compatibilidad Node 20+).
- Node requerido: **>= 20** (actualizado en `package.json` raíz).
- Auth admin: header `x-admin-token` o `Authorization: Bearer` contra `BACKEND2_ADMIN_TOKEN` (vacío = abierto en dev).
- Despliegue web: NestJS sirve `apps/web/dist` con fallback SPA; en dev se usa Vite con proxy `/api` → `:3000`.

**Lo implementado (verificado con build + lint + tests + QR real)**
- `whatsapp/whatsapp.service.ts` — ConnectionManager: auth state en filesystem, QR como data-URL, auto-reconnect con backoff exponencial (`WA_MAX_RECONNECT`), reenvío de inbound a backend 1.
- `whatsapp/whatsapp.controller.ts` — `GET /api/whatsapp/status`, `GET /api/whatsapp/qr`, `POST /api/whatsapp/connect`, `POST /api/whatsapp/send` (protegidos por token admin cuando está definido).
- `webhooks/webhooks.controller.ts` + `service` — `POST /webhooks/notify` (Bearer `BACKEND1_SHARED_TOKEN`, idempotencia 5 min, validación).
- `main.ts` — CORS, trust proxy, estáticos + fallback SPA.
- Frontend React: tarjeta de estado, QR, botón Reconectar, formulario de prueba, log de actividad, campo token admin.
- Pruebas: `app.controller.spec.ts` (unit) + 2 e2e (`/health`, `/api/whatsapp/status`).
- `README.md`, `.env.example`, `.gitignore` raíz (corrige el colgaso por `node_modules/`).

**Correcciones al plan original**
- Rutas admin: `/api/whatsapp/...` (no `/whatsapp/...`).
- `data/auth` por defecto bajo `apps/api` (cwd); en Render usar `/data/auth`.
- QR/estado visibles solo con token admin si `BACKEND2_ADMIN_TOKEN` está definido.

**Pendientes (deudas técnicas)**
- **`.env` no se carga automáticamente** (falta dotenv o `@nestjs/config`) → el código lee `process.env`; hasta conectarlo, exportar vars en la shell.
- Definir `BACKEND1_BASE_URL` + `BACKEND1_SHARED_TOKEN` + contrato de inbound para activar el reenvío.
- Test real paso 8: escanear QR, enviar mensaje, recibir respuesta.
- Deploy Render paso 9: disk `/data`, keep-alive, Node 22+, fijar `BACKEND2_ADMIN_TOKEN` y `NODE_ENV=production`.
- Opcionales: polling fallback, IP allowlist en `/webhooks/notify`, más tests de notify, primer commit del repo.

### Sesión 3 — 2026-10-07 (asistente conversacional con LLM)

**Objetivo añadido por el usuario**: que alguien pregunte al bot y éste responda
según la pregunta; si requiere datos de su cuenta, consulte a backend 1.

**Decisiones**
- LLM externo (nada local, no cabe en el free tier). Proveedor por defecto **Groq
  free tier** (`openai/gpt-oss-20b`), API compatible con OpenAI.
- Respuesta de backend 1: **síncrona** al mismo POST de inbound (`{ reply | data }`).
- Si el LLM/backend 1 falla: **respuesta de respaldo** configurable.
- Costo: **$0** (Groq free tier, sin tarjeta).
- Modelos disponibles verificados vía `GET /openai/v1/models`: `openai/gpt-oss-20b`,
  `openai/gpt-oss-120b` (los llama salieron del tier gratuito). Function calling probado ✅.

**Implementado**
- `apps/api/src/assistant/llm.service.ts`: cliente `fetch` OpenAI-compatible + tools.
- `apps/api/src/assistant/assistant.service.ts`: memoria por remitente (TTL + tamaño),
  tool `consult_backend` (POST síncrono a backend 1), fallback en timeout/`429`, prompt
  anti-injection, `reasoning_effort=low`.
- `assistant.module.ts` + wiring en `whatsapp.service.ts` (`handleInbound` → LLM →
  `sendReply`; si no hay LLM, reenvío actual).
- `config.ts` + `.env.example`: vars `LLM_*`, `BACKEND1_REPLY_TIMEOUT_MS`,
  `FALLBACK_REPLY`, `CHAT_HISTORY_*`.
- Tests: `llm.service.spec.ts` y `assistant.service.spec.ts`.

**Límites a vigilar (Groq free)**: 30 RPM · 1k req/día · 8k tokens/min · 200k tokens/día
por modelo. Un mensaje = 1–2 llamadas → ~500 conversaciones/día. Prompt de sistema fijo
para aprovechar caché.

**Pendientes**
- Backend 1 debe responder el POST síncrono con la data (contrato aún por definir).
- Probar en real: `LLM_API_KEY` en `.env`, QR y una conversación de punta a punta.

### Sesión 4 — 2026-10-07 (control de acceso)

**Motivo**: usar número personal antes de tener número dedicado; evitar que el bot
responda a contactos no deseados.

**Decidido**: no autorizados se **ignoran en silencio**; **grupos ignorados** por defecto.

**Implementado**
- `common/phone.ts`: `normalizePhone` (quita `+`, espacios y sufijo `:dispositivo@s.whatsapp.net`) y `parsePhoneList`.
- `common/access.ts`: `decideAccess` (pura y testeable).
- `config.ts`: `WHATSAPP_ALLOWED_NUMBERS` (vacío = todos) y `WHATSAPP_ALLOW_GROUPS`.
- `whatsapp.service.ts`: normaliza `fromNumber` y aplica el filtro en `handleInbound`
  (antes del asistente; aplica con o sin LLM).
- Nota corregida: antes `fromNumber` podía quedar como `59172830478:24` en multidispositivo.
- Tests: `phone.spec.ts`, `access.spec.ts`. Docs actualizadas.

**Futuro**: `BACKEND1_CHECK_CUSTOMER=true` + interfaz `isAuthorized` que consulte backend 1,
con la allowlist como respaldo.

### Sesión 5 — 2026-10-07 (gestión de números desde el panel)

**Petición**: agregar números autorizados desde el frontend; en memoria (se borran al
reiniciar, aceptado) y **solo números bolivianos**.

**Implementado**
- `common/phone.ts`: `normalizeBolivianPhone` → `591` + 8 dígitos móvil (inicia en 6 o 7);
  acepta `72830478`, `+591 72830478`, `59172830478`.
- `whatsapp/allowlist.service.ts` (in-memory): `allowed()`, `list()` (con `source: env|runtime`),
  `add()`, `remove()` (los de env no se quitan).
- `whatsapp.controller.ts`: `GET/POST /api/whatsapp/allowed`, `DELETE /api/whatsapp/allowed/:number`
  (protegidos con `AdminGuard`).
- `whatsapp.service.ts`: `decideAccess` usa `allowlist.allowed()`.
- Frontend: `api.ts` (`fetchAllowed/addAllowed/removeAllowed`) + tarjeta "Números autorizados"
  en `App.tsx` (agregar, listar, quitar; etiqueta `env`; aviso de memoria volátil) + estilos.
- Tests: `allowlist.service.spec.ts`, `normalizeBolivianPhone` en `phone.spec.ts`.
- `.env.example`, `README.md` actualizados.

**Nota**: la lista runtime se pierde en cada restart; para fijar números usar
`WHATSAPP_ALLOWED_NUMBERS`.
