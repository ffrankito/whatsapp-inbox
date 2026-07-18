# WhatsApp Inbox — Empresa de Monitoreo × GoHighLevel

## 1. Contexto de negocio

La empresa se dedica a **monitoreo** (alarmas) y tiene tres públicos que le escriben por
WhatsApp: **dealers**, **abonados**, y usuarios de la **app Full Control** (la app propia
de monitoreo de la empresa). Hoy ya operan **3 números de WhatsApp**, uno por público —
cada uno dedicado a un público fijo, no se mezclan entre números. Los 3
números siguen usándose activamente desde la **app de WhatsApp Business en el celular** del
equipo, y eso no se puede perder (ver §3.1, Coexistencia).

Este inbox es para el **área comercial** (dealers/abonados) — no se mezcla con el proyecto
`security24-rag` (chatbot RAG interno de procesos, en Python, para otra área de la
empresa). Son dos proyectos separados, sin dependencias entre sí.

GHL (`app.gohighlevel.com`, location `QEmYqBPWjjngZgBXZfTf`) es el CRM de la empresa.
Todo el desarrollo/testing se hace primero contra una **cuenta sandbox de developer**
(agencia de prueba separada, sin ningún vínculo con la cuenta real de Security24), con una
sub-cuenta de test: location `UnDaROg6tyLshlODU22O`. Recién cuando ande de punta a punta
ahí se repite la instalación de la app sobre la location real.

Hoy esos 3 números de WhatsApp **no están conectados a GHL**. El objetivo de este proyecto
es construir un **inbox de WhatsApp propio**, con selector para los 3 números, que quede
**integrado visualmente dentro de GHL** (no una app/URL aparte) y que dejen registro de
cada conversación en GHL (para más adelante agregar notas/auditoría por chat ahí mismo).

Referencia de patrón de código: hay un inbox de WhatsApp de un solo número ya funcionando
para otro proyecto/cliente distinto (Aires de Paz / Huellas de Paz, crematorio de
mascotas, `D:\HuellasDePaz\HuellasDePaz\crm`) — sirve de referencia de stack y de UI, pero
es un proyecto separado, sin GHL, y con un modelo de auth que **no** sirve para este caso
(ver §5).

## 2. Objetivos y restricciones

- Los 3 números **no se pueden mezclar** — cada uno mantiene su público (dealer / abonado
  / usuarios app Full Control) intacto tal como está organizado hoy.
- El inbox tiene que **verse dentro de GHL**, no como pestaña/dominio separado.
- Los mensajes tienen que quedar **guardados en GHL** (conversación + contacto), para que
  ahí se puedan agregar notas y auditoría por chat en una etapa siguiente.
- No romper nada de lo que ya funciona hoy con los 3 números en Meta.

## 3. Por qué esta arquitectura (research validado contra la API real de GHL)

Se investigó contra el spec OpenAPI oficial de GHL
(`github.com/GoHighLevel/highlevel-api-docs`) y su documentación pública. Hallazgos clave:

| Pregunta | Respuesta confirmada |
|---|---|
| ¿Un Private Integration Token alcanza para meter un canal de WhatsApp custom en GHL? | **No.** Registrar un *Conversation Provider* requiere una Marketplace App con OAuth (puede ser privada/no listada). |
| ¿Meta permite varios números en la misma cuenta/app? | **Sí**, sin restricciones — cada mensaje trae su `phone_number_id`, así se identifica a qué número le escribieron. |
| ¿Se puede tener un inbox propio "dentro" de GHL? | **Sí**, vía **Custom Menu Link** con `openMode: iframe` — agrega un ítem al menú de GHL que carga tu propia app dentro de un iframe. |
| ¿Cómo sabe el iframe qué usuario/location de GHL lo abrió (sin pedir login propio)? | GHL expone un flujo de **SSO por `postMessage`**: el iframe pide `REQUEST_USER_DATA`, recibe un payload cifrado (AES) que se descifra en el backend con el *Shared Secret* de la app (distinto del Client Secret OAuth), y da `activeLocation`, `userId`, `userName`, `role`. |
| ¿Cómo se mete un mensaje entrante al historial de GHL? | `POST /conversations/messages/inbound` con `type: WhatsApp` + `conversationProviderId` del número. |
| ¿Cómo se manda un mensaje saliente registrado en GHL? | `POST /conversations/messages` (GHL). Si el canal es un Custom Provider, GHL dispara el webhook **Delivery URL** configurado para ese provider — ahí es donde nosotros realmente hablamos con la capa de WhatsApp. |
| ¿Dónde se resuelve el contacto por teléfono? | `POST /contacts/upsert`. |
| ¿Dónde van las notas? | `POST /contacts/{contactId}/notes` (a nivel de contacto, en GHL). |

### 3.1 Coexistencia con Meta — por qué no se puede ir directo a la Cloud API

Se confirmó investigando la documentación de Meta que **"Coexistencia"** (que un número
siga funcionando en la app de WhatsApp Business del celular Y al mismo tiempo por API) es
una función que **solo se activa a través de un partner/Tech Provider de Meta usando el
flujo de Embedded Signup** — el self-signup directo a la Cloud API (registrar un número
"de cero" vos mismo) no ofrece esa opción, y por eso Meta pedía "números totalmente
nuevos" cuando se intentó directo.

Como los **3 números necesitan mantener coexistencia** (el equipo los sigue usando desde
el celular), no es viable que nuestro propio backend hable directo con la Cloud API de
Meta — haría falta que nuestra empresa sea aprobada como Tech Provider de Meta, algo fuera
de alcance para este proyecto.

**Se usa [Kapso](https://kapso.ai) como capa intermedia** (BSP): Kapso ya está aprobado
como partner de Meta, soporta el flujo de Embedded Signup con coexistencia, y soporta
conectar varios números en la misma cuenta (mientras el Business Portfolio de Meta tenga
capacidad). Es el mismo proveedor que ya se usa en Huellas de Paz — ahí no hacía falta
coexistencia (número nuevo, sin uso en el celular), acá sí, así que esta vez es
imprescindible en vez de opcional. Nada del diseño con GHL cambia por esto — solo cambia
la capa que efectivamente manda/recibe los mensajes de WhatsApp: en vez de hablar directo
con `graph.facebook.com`, el backend habla con la API de Kapso (que a su vez habla con
Meta y mantiene la coexistencia).

### 3.2 Foto de perfil del contacto — no es viable, independiente del proveedor

Se investigó específicamente esto: **la WhatsApp Business Platform (Cloud API) no expone
la foto de perfil de los contactos a los negocios, sin importar qué proveedor/BSP se use**
(ni Kapso, ni 360dialog, ni Twilio, ni nadie). Es una restricción de privacidad a nivel de
la plataforma de Meta — la foto de perfil solo es visible dentro de la app de WhatsApp
para contactos guardados en la agenda del teléfono, no vía API de negocio. Se descarta
como funcionalidad; no se va a intentar destrabar cambiando de proveedor.

## 4. Decisiones de diseño

1. **GHL es la fuente de verdad de conversaciones, mensajes y notas.** No se duplica una
   tabla de mensajes local — el backend siempre lee/escribe contra la API de GHL. Solo se
   persiste lo que GHL no puede darnos: tokens de instalación OAuth.
2. **Un único punto real de envío hacia WhatsApp.** No importa si el agente responde desde
   nuestro inbox o desde el inbox nativo de GHL: el mensaje siempre pasa por
   `POST /conversations/messages` en GHL, que dispara nuestro webhook *Delivery URL*
   (`/api/ghl/outbound`) — ahí, y solo ahí, se llama a la API de Kapso (que efectivamente
   entrega el mensaje por WhatsApp manteniendo la coexistencia). Evita duplicar envíos.
3. **Auth vía SSO de GHL, no login propio.** El iframe pide el contexto de usuario por
   `postMessage`, el backend lo descifra y emite una sesión corta propia (cookie
   `SameSite=None; Secure`). Nada de pantallas de login ni redirects — no funcionan bien
   dentro de un iframe de terceros.
4. **Los 3 números son configuración estática** (variables de entorno + un archivo de
   config), no una tabla administrable en base de datos — son fijos y son solo 3.
5. **Actualización en tiempo real vía SSE propio, no polling.** Decisión revisada dos
   veces: primero se sacó el polling de 5s porque significaba hasta 5 segundos de demora
   en enterarse de un mensaje nuevo — inaceptable para una empresa de monitoreo de
   alarmas. La primera solución (Supabase Realtime) después se simplificó a SSE directo
   al confirmarse que el despliegue es un contenedor Docker persistente en el data center
   de la empresa, no Vercel serverless. Ver §5.1.
6. **Deploy: contenedor Docker en el data center de la empresa, no Vercel.** Confirmado
   que la empresa tiene servidores propios con salida pública a internet — el proyecto se
   empaqueta como imagen Docker (`next build` en modo `standalone`) y corre ahí, detrás
   de un reverse proxy con TLS que expone el dominio real. Ver §7.1.

## 5. Por qué NO se reutiliza el auth de Huellas de Paz

Huellas de Paz usa **Supabase Auth con sesión por cookie + redirect** (`middleware.ts`
redirige a `/auth/login` si no hay sesión válida). Ese patrón no sirve acá porque:

- Corre dentro de un **iframe de terceros** (el Custom Menu Link de GHL) — un redirect de
  navegación top-level dentro del iframe se rompe o falla silenciosamente.
- Cookies de terceros pueden estar bloqueadas por el navegador (Safari ITP, políticas de
  Chrome), rompiendo el modelo de sesión por cookie clásico.
- GHL ya autenticó al usuario — no hace falta pedirle login de nuevo: alcanza con leer el
  contexto que GHL nos pasa por SSO.

Sí se reutilizan de Huellas de Paz: el stack (Next.js + Drizzle + Tailwind) y el estilo
de UI tipo WhatsApp para el hilo de mensajes. El patrón de polling de Huellas de Paz
**no** se reutiliza acá — ver §5.1.

**Nota de versión:** el scaffold quedó en **Next.js 16** (no 15) — trae cambios reales:
`params`, `cookies()` y `headers()` son siempre async (sin fallback sync), y
`middleware.ts` pasó a llamarse `proxy.ts`. Se tuvo en cuenta al escribir los route
handlers.

### 5.1 Tiempo real: SSE propio, sin intermediario externo

**Revisado de nuevo (segunda vuelta):** la primera versión de esta sección decía que
había que usar Supabase Realtime como intermediario porque Server-Sent Events no
funciona bien sobre hosting serverless (Vercel) — dos invocaciones de función no
comparten memoria, así que el webhook que recibe el mensaje no tiene forma de avisarle
directamente a la conexión SSE abierta de otro cliente.

Esa restricción **ya no aplica**: el proyecto se despliega como **contenedor Docker en
el data center de la empresa**, no en Vercel — es un proceso Node único y persistente,
no funciones serverless efímeras. Eso significa que el webhook y la conexión SSE viven
en el mismo proceso y sí pueden comunicarse directo, en memoria, sin pasar por ningún
servicio externo. Se saca Supabase Realtime del diseño — una dependencia externa menos,
y un salto de red menos en el camino más urgente del sistema (avisar que llegó un
mensaje).

Mecanismo: un `EventEmitter` de Node compartido (`src/lib/events.ts`). Los webhooks
(`/api/kapso/webhook`, `/api/ghl/outbound`) emiten un evento chico
(`{ tipo, numero, conversationId }`) después de procesar el mensaje. La ruta
`/api/eventos` (SSE) mantiene la conexión abierta con el navegador y reenvía cada evento
apenas llega. El inbox, al recibir el evento, vuelve a pedir los datos frescos de esa
conversación puntual — misma lógica de fetch que ya existía, solo que ahora se dispara
por evento en vez de por timer.

Se mantiene un poll de respaldo, mucho más espaciado (30–60s), como red de seguridad por
si se corta la conexión SSE (reinicio del contenedor, deploy, etc.) — no como mecanismo
principal.

**Nota si en el futuro se corre más de una réplica del contenedor** (balanceo de carga):
este esquema en memoria deja de alcanzar, porque el webhook puede caer en una réplica
distinta a la que tiene la conexión SSE del navegador — ahí sí haría falta volver a un
intermediario compartido (Redis pub/sub, por ejemplo). Con una sola réplica (el caso de
hoy) no hace falta esa complejidad.

## 6. Flujo end-to-end

### Entrante (alguien escribe por WhatsApp)
```
Meta  → Kapso (coexistencia)
  → POST /api/kapso/webhook   (valida firma HMAC, igual que en Huellas de Paz)
  → identifica el número por "phone_number_id" del payload
  → POST /contacts/upsert (GHL)            [resuelve/crea el contacto por teléfono]
  → POST /conversations/messages/inbound   [type: WhatsApp, conversationProviderId del número]
  → GHL crea/actualiza la conversación
  → emite evento en el EventEmitter interno {tipo: "mensaje", numero, conversationId}
  → /api/eventos (SSE) lo reenvía a los navegadores conectados
  → nuestro /inbox refetchea esa conversación al instante
```

### Saliente (un agente responde, desde nuestro inbox o desde el nativo de GHL)
```
agente responde
  → POST /conversations/messages (GHL)
  → GHL llama a la Delivery URL del Conversation Provider → /api/ghl/outbound
  → resolvemos el número por "conversationProviderId"
  → API de Kapso → Meta (coexistencia) → envío real
  → PUT /conversations/messages/{id}/status   [delivered | failed]
  → emite evento en el EventEmitter interno {tipo: "estado", numero, conversationId, messageId}
  → /api/eventos (SSE) lo reenvía a los navegadores conectados
  → nuestro /inbox actualiza el estado del mensaje (✓ entregado / ✕ falló) al instante
```

### Notas / auditoría
```
agente agrega nota en el hilo
  → POST /contacts/{contactId}/notes (GHL, directo, sin tabla propia)
```

## 7. Estructura del proyecto

```
src/
  app/
    inbox/page.tsx                          # UI embebida en el iframe (selector 3 números + lista + hilo)
    api/
      kapso/webhook/route.ts                # GET verify + POST inbound (Kapso -> nosotros)
      eventos/route.ts                      # SSE: mantiene la conexión abierta con /inbox
      ghl/
        oauth/callback/route.ts             # intercambia code por tokens, guarda en DB
        session/route.ts                    # recibe payload SSO cifrado, descifra, emite cookie de sesión
        outbound/route.ts                   # Delivery URL: GHL -> nosotros -> Kapso
      conversaciones/route.ts               # proxy: lista conversaciones por numeroId (GHL search)
      conversaciones/[id]/route.ts          # proxy: detalle/hilo (GHL)
      conversaciones/[id]/responder/route.ts# agente responde -> POST /conversations/messages
      conversaciones/[id]/notas/route.ts    # proxy directo a POST /contacts/{id}/notes
  lib/
    ghl/
      client.ts        # wrapper fetch autenticado (maneja refresh de access token)
      numeros.ts        # config estática de los 3 números (nombre, público, phoneNumberId, conversationProviderId)
      sso.ts            # descifrado AES del payload de user-context
    kapso/
      client.ts         # envío de mensajes vía Kapso (recibe numeroId, resuelve token/phoneNumberId)
    events.ts            # EventEmitter compartido en memoria (webhooks emiten, /api/eventos escucha)
    mode.ts               # DEMO_MODE / STANDALONE_MODE — qué rama usa cada ruta (§14)
    demo/store.ts          # datos de ejemplo en memoria (Fase 1)
    standalone/store.ts    # conversaciones reales en memoria, sin GHL todavía (Fase 2)
  db/
    schema/ghl.ts        # tabla ghlInstalls: locationId, accessToken, refreshToken, expiresAt
```

### 7.1 Deploy: Docker en el data center de la empresa

- `next.config.ts` con `output: 'standalone'` — genera un build mínimo pensado para
  correr en contenedor, sin depender de `node_modules` completo adentro de la imagen.
- `Dockerfile` multi-stage (build → imagen final liviana con solo lo necesario para
  `next start`).
- Corre detrás de un **reverse proxy** (nginx/Traefik, lo que ya use la empresa) que
  termina TLS y expone el dominio real — necesario porque la cookie de sesión usa
  `Secure; SameSite=None` (obligatorio para funcionar dentro del iframe de GHL).
- Al ser un único proceso persistente (no serverless), el EventEmitter en memoria de
  `lib/events.ts` funciona sin infraestructura adicional — ver §5.1 para la limitación
  si en el futuro se corre más de una réplica.

## 8. Variables de entorno

```
GHL_CLIENT_ID=
GHL_CLIENT_SECRET=
GHL_SHARED_SECRET_SSO=
GHL_REDIRECT_URI=
DATABASE_URL=                # Postgres, solo para ghlInstalls — Supabase Cloud o
                              # self-hosted en el mismo data center (a definir, el
                              # código no cambia según cuál se elija)

KAPSO_APP_SECRET=            # HMAC verificación webhook (ver si es compartido o por número)
KAPSO_VERIFY_TOKEN=

WA_DEALERS_PHONE_ID=          # phone_number_id en Kapso/Meta
WA_DEALERS_API_KEY=           # X-API-Key de Kapso para ese número
WA_DEALERS_PROVIDER_ID=       # conversationProviderId del Custom Provider en GHL

WA_ABONADOS_PHONE_ID=
WA_ABONADOS_API_KEY=
WA_ABONADOS_PROVIDER_ID=

WA_FULLCONTROL_PHONE_ID=
WA_FULLCONTROL_API_KEY=
WA_FULLCONTROL_PROVIDER_ID=
```
(públicos confirmados: dealers, abonados, usuarios de la app Full Control)

## 9. Setup manual (antes de poder probar end-to-end)

### 9.1 Kapso — coexistencia de los 3 números (paso previo, bloqueante)
1. Crear/usar una cuenta de Kapso con el Business Portfolio de Meta de la empresa
   (verificar que tenga capacidad para 3 números).
2. Por cada uno de los 3 números: conectar vía el flujo de **Embedded Signup** de Kapso,
   confirmando que quede en modo **coexistencia** (el número sigue funcionando en la app
   del celular).
3. Guardar por cada número: `phone_number_id` y el API key de Kapso correspondiente →
   van a las variables `WA_<NUMERO>_PHONE_ID` / `WA_<NUMERO>_API_KEY`.
4. Configurar en Kapso el webhook hacia `https://<dominio>/api/kapso/webhook` para los 3
   números.

### 9.2 GHL — Marketplace App + Conversation Providers
1. Crear una **Marketplace App privada** en `marketplace.gohighlevel.com` → sección Auth:
   generar Client ID/Secret + **Shared Secret (SSO)** + configurar Redirect URI.
2. Scopes necesarios: `conversations.readonly`, `conversations.write`,
   `conversations/message.readonly`, `conversations/message.write`, `contacts.readonly`,
   `contacts.write`.
3. Sección **Conversation Providers**: crear **3 providers** (uno por número), cada uno
   con su propia Delivery URL (`https://<dominio>/api/ghl/outbound?numero=<id>`) →
   guardar los 3 `conversationProviderId` generados.
4. Sección **Custom Menu Link**: crear el ítem de menú, `openMode: iframe`,
   `url: https://<dominio>/inbox`.
5. Instalar la app en la location `QEmYqBPWjjngZgBXZfTf` → dispara el OAuth callback que
   guarda el access/refresh token de esa location.

## 10. Verificación end-to-end

1. `npm run dev`, probar `/inbox` fuera del iframe primero (datos mock) antes de integrar
   GHL real.
2. Mandar un WhatsApp real a uno de los 3 números → confirmar que aparece tanto en el
   inbox nativo de GHL como en `/inbox`.
3. Responder desde `/inbox` → confirmar que llega por WhatsApp de verdad y que el estado
   pasa a `delivered` en GHL.
4. Abrir `/inbox` desde el Custom Menu Link dentro de GHL real → validar SSO (sin login
   propio, contexto de usuario correcto).
5. Mandar mensajes a los 3 números en paralelo → confirmar que el selector los separa sin
   mezclarlos.
6. Con `/inbox` abierto y quieto (sin tocar nada), mandar un WhatsApp de prueba →
   confirmar que aparece **sin recargar la página** y sin esperar el poll de respaldo
   (30–60s) — si tarda eso, revisar primero el reverse proxy (buffering en `/api/eventos`,
   §11) antes de sospechar del código.
7. Reiniciar el contenedor Docker con `/inbox` abierto → confirmar que el poll de
   respaldo lo recupera solo (sin que el agente tenga que refrescar la página a mano).

## 11. Abierto / a confirmar más adelante

- Formato exacto en el que se van a guardar las notas/auditoría por chat en GHL (nota
  simple de texto vs. algo más estructurado) — se define cuando lleguemos a esa parte.
- Si el mismo secreto de webhook de Kapso es compartido entre los 3 números o si cada uno
  tiene el suyo.
- Confirmar con Kapso que el Business Portfolio de Meta de la empresa tiene capacidad para
  los 3 números en coexistencia antes de arrancar el onboarding (§9.1).
- Definir si Postgres corre en Supabase Cloud o self-hosted en el mismo data center
  (§8) — no cambia código, sí cambia el setup de la Fase 1.
- **Ojo con el reverse proxy y SSE**: hay que confirmar que el proxy que exponga el
  dominio (nginx/Traefik) no bufferee la respuesta de `/api/eventos` — si lo hace, corta
  la conexión persistente y el tiempo real deja de funcionar sin que se note fácil por
  qué (con nginx, por ejemplo, hace falta `proxy_buffering off;` en esa ruta).

## 12. Descartado

- **Foto de perfil del contacto**: no es viable vía WhatsApp Business Platform con ningún
  proveedor (restricción de privacidad de Meta a nivel de plataforma). No se implementa.
- **Meta Cloud API directa (sin BSP)**: descartada porque no soporta coexistencia en
  self-signup, y los 3 números la necesitan (§3.1).

## 13. Manejo de errores y trazabilidad del relay

Hueco identificado al revisar el proyecto `security24-rag` (otra área, mismo criterio de
"empresa de monitoreo → un mensaje perdido en silencio es grave", no un detalle
cosmético). Dos cosas concretas a resolver desde el arranque, no después:

1. **Error handling explícito en cada webhook/route.** `/api/kapso/webhook` y
   `/api/ghl/outbound` no pueden devolver un 500 crudo si falla una llamada a GHL o a
   Kapso — hay que capturar el error, loguearlo con contexto (qué número, qué
   conversación) y devolver una respuesta que el llamador entienda (Kapso/GHL reintentan
   webhooks fallidos, así que un error claro con status code correcto es preferible a un
   crash silencioso).
2. **Log estructurado mínimo del relay** — no una tabla de auditoría de negocio (eso ya
   está resuelto vía notas en GHL, §6), sino trazabilidad técnica: por cada mensaje que
   entra o sale, registrar número involucrado, dirección, si se pudo insertar/enviar en
   GHL y en Kapso, y el error si lo hubo. Alcanza con logs estructurados (JSON) — no hace
   falta una herramienta tipo Langfuse para este volumen. Sirve para responder "¿por qué
   no le llegó tal mensaje a tal dealer?" sin tener que reproducir el bug a ciegas.

## 14. Modos temporales de despliegue (rollout en etapas)

El rollout no va directo de "nada" a "todo conectado a GHL" — se agregaron dos modos
transitorios, cada uno pensado para poder mostrar/probar algo concreto sin haber
terminado toda la integración (ver `docs/ROADMAP.md` Fases 1 y 2 para el detalle
completo). Ninguno de los dos es parte del diseño final — son puentes.

### 14.1 Modo demo (Fase 1)

Sin `GHL_LOCATION_ID` configurado, `/api/conversaciones` y `/api/conversaciones/[id]`
devuelven datos de ejemplo fijos en vez de llamar a GHL, y "Enviar"/"Guardar nota" solo
actualizan el estado en memoria del navegador. Objetivo: mostrar el diseño con algo
clickeable antes de conectar nada real. No requiere base de datos ni Kapso.

### 14.2 Prueba standalone con Kapso real, sin GHL (Fase 2)

Con uno o los 3 números ya conectados por Kapso pero **antes** de tener lista la
integración con GHL (Fases 3–4), el webhook de Kapso guarda los mensajes entrantes **en
memoria del proceso** en vez de reenviarlos a GHL — es una excepción deliberada, y
temporal, a la decisión de diseño §4.1 ("GHL es la fuente de verdad"). Se puede porque
el número sigue en coexistencia: el historial real de la conversación sigue existiendo
en la app de WhatsApp del celular igual, así que no hay pérdida de información real
aunque el proceso se reinicie y la copia en memoria se pierda.

**Esto se descarta en la Fase 6**, cuando el webhook pasa a llamar a
`src/lib/ghl/client.ts` (ya escrito desde el arranque del proyecto, sin usar todavía) en
vez de guardar en memoria — recién ahí GHL pasa a ser la fuente de verdad de verdad,
como dice el diseño final.

## 15. Seguridad — huecos conocidos (se cierran en la Fase 5 del roadmap)

Revisión honesta hecha sobre el código ya escrito. Lo que está bien:

- **Webhooks verificados de verdad**: `/api/kapso/webhook` valida HMAC-SHA256 con
  comparación a prueba de timing attacks (`timingSafeEqual`); `/api/ghl/outbound` valida
  la firma Ed25519 de GHL contra su clave pública oficial (`lib/ghl/verifyWebhook.ts`).
  Nadie puede simular un mensaje de Kapso o un aviso de GHL sin la firma correcta.
- **Secretos fuera del repo**: todo en `.env.local`, cubierto por `.gitignore`.
- **Cookie de sesión `httpOnly`**: JS del lado del cliente no puede leerla (protege
  contra robo vía XSS). El contexto de usuario se descifra únicamente en el servidor.
- **Tokens OAuth de GHL nunca llegan al navegador** — viven solo en `ghlInstalls` y se
  usan del lado del servidor.
- React escapa el texto de los mensajes por default — un mensaje de WhatsApp con
  contenido malicioso no se ejecuta al renderizarlo en el hilo.

Lo que falta cerrar:

1. ~~CSRF en `/responder` y `/notas`~~ — **resuelto**: ambos exigen el header
   `x-s24-inbox` (`src/lib/csrf.ts`), que solo el frontend propio manda — un sitio
   externo no puede agregar headers custom sin preflight CORS, que no autorizamos.
   Probado: sin header → 403, con header → funciona.
2. ~~Sin rate limiting~~ — **resuelto**: `src/lib/rateLimit.ts`, 60 pedidos/minuto por IP
   en `/api/kapso/webhook` y `/api/ghl/outbound`. Probado con una ráfaga real (pedido 61
   devolvió 429).
3. **Sin control de acceso por rol** dentro del inbox — cualquier usuario de GHL con
   acceso al Custom Menu Link ve los 3 números, no hay separación por equipo todavía.
   A confirmar si hace falta.
4. ~~Dockerfile todavía no escrito~~ — **resuelto**: `Dockerfile` multi-stage sobre
   `node:22-alpine`, corre como usuario `nextjs` sin privilegios, probado localmente
   (build + contenedor levantando + modo demo respondiendo desde adentro).
5. ~~`npm audit` sin revisar~~ — **revisado**: las 6 vulnerabilidades moderadas son de
   herramientas de build/dev (esbuild vía `drizzle-kit`, postcss vía `next`), sin
   exploit posible en cómo se usan acá — no exponemos el dev-server de esbuild, y no
   procesamos CSS de terceros. `npm audit fix --force` bajaría Next.js a la v9 y
   `drizzle-kit` a una versión vieja — **no aplicar**, sería peor que el problema.
   Revisar de nuevo si en algún momento aparece un fix sin breaking changes.
