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

**Implementado y probado.** Mecanismo: un `EventEmitter` de Node compartido
(`src/lib/events.ts`). Los webhooks (`/api/kapso/webhook`, `/api/ghl/outbound`,
`/api/conversaciones/[id]/responder` en modo standalone) emiten un evento chico
(`{ tipo: "mensaje" | "estado", numero }`) después de procesar el mensaje — se
simplificó a nivel de número en vez de conversación puntual, así el inbox simplemente
refresca la lista y (si hay una abierta) la conversación seleccionada del número activo,
sin depender de poder correlacionar el `conversationId` exacto en todos los casos
(el payload del Delivery URL de GHL, por ejemplo, no lo incluye). La ruta `/api/eventos`
(SSE) mantiene la conexión abierta con el navegador y reenvía cada evento apenas llega.

Prueba real hecha: conexión SSE abierta + webhook de Kapso simulado (firmado) →
el evento `{"tipo":"mensaje","numero":"dealers"}` llegó al cliente al instante.

Se mantiene un poll de respaldo, mucho más espaciado (45s), como red de seguridad por
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
  → emite evento en el EventEmitter interno {tipo: "mensaje", numero}
  → /api/eventos (SSE) lo reenvía a los navegadores conectados
  → nuestro /inbox refetchea la lista y la conversación abierta (si es de ese número)
```

### Saliente (un agente responde, desde nuestro inbox o desde el nativo de GHL)
```
agente responde
  → POST /conversations/messages (GHL)
  → GHL llama a la Delivery URL del Conversation Provider → /api/ghl/outbound
  → resolvemos el número por "conversationProviderId"
  → API de Kapso → Meta (coexistencia) → envío real
  → PUT /conversations/messages/{id}/status   [delivered | failed]
  → emite evento en el EventEmitter interno {tipo: "estado", numero}
  → /api/eventos (SSE) lo reenvía a los navegadores conectados
  → nuestro /inbox refetchea la conversación abierta (si es de ese número)
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

## 16. Corrección del payload de Kapso (con evidencia real, no adivinado)

La forma original de `src/app/api/kapso/webhook/route.ts` (`whatsapp_config.phone_number_id`)
era una suposición sin confirmar, marcada como riesgo conocido. Se corrigió con evidencia
de dos fuentes independientes:

1. El inbox de WhatsApp de Huellas de Paz (mismo proveedor, Kapso, corriendo en
   producción hoy) — confirma `conversation.phone_number` (con "+", hay que sacarlo) y
   `conversation.kapso.contact_name`.
2. El código fuente del SDK y la reference-app oficial de Kapso
   (`github.com/gokapso/whatsapp-cloud-api-js` y `whatsapp-cloud-inbox`) más su
   documentación (`docs.kapso.ai`) — confirma que `phone_number_id` va en la **raíz**
   del payload (o en `conversation.phone_number_id`), nunca dentro de un objeto
   `whatsapp_config` (eso no existe en ningún lado de la doc de Kapso).

Toda la lógica de parseo quedó centralizada en `src/lib/kapso/parseWebhook.ts`
(`parsearMensajeEntrante`), en vez de vivir inline en la ruta — así queda un solo lugar
para ajustar si aparece algo más por confirmar contra un webhook real.

**Sigue pendiente**: Kapso soporta un modo de webhooks "en batch" (`{ batch: true, data:
[...] }`) — no está habilitado hoy así que no se maneja, pero si en algún momento se
activa, `parsearMensajeEntrante` va a necesitar iterar `payload.data` en vez de leer el
payload directo.

## 17. Adjuntos multimedia (audio, imágenes, documentos)

Pedido explícito: paridad con Huellas de Paz, que ya maneja audio y documentos.

**Recibir:** Kapso espeja el archivo a una URL propia (`message.kapso.media_url`) poco
después de recibirlo — se usa esa URL directo, **sin re-hostear en storage propio**
(a diferencia de Huellas de Paz, que descarga por `mediaId` y sube a Supabase Storage —
ese paso ya no hace falta gracias a que Kapso lo resuelve solo). Si el mensaje llega
antes de que Kapso termine de espejarlo, se guarda como texto (`"[Audio — todavía
procesándose]"`) sin adjunto — limitación conocida, no se reintenta la descarga.

**Mandar:** se sube el archivo directo a la API de medios de Kapso
(`POST {phoneNumberId}/media`, confirmado contra el SDK oficial) y se manda por
`id` — tampoco hace falta storage propio para esto. Para mostrarlo en nuestro propio
hilo (ya que Kapso no devuelve una URL pública de lo que nosotros subimos) se guarda
como `data:` URL en memoria — límite de 8MB por archivo, suficiente para audios/
documentos cortos, sin agregar una dependencia de storage externo en esta etapa.

Tipos soportados: imagen, audio, documento, video. Sticker/ubicación/reacciones no
están soportados todavía.

## 18. Asignación / bloqueo entre agentes

Pedido explícito: cuando un agente toma una conversación, otros agentes no pueden
responder hasta que la libere. Mismo patrón que ya usa Huellas de Paz
(`asignadaAId` + acción "tomar"), replicado acá.

**Estados:** `sin_asignar` → `asignada` (con `asignadaA: {id, nombre}`) → `cerrada`.
Cualquiera puede tomar una conversación sin asignar, pero **hay que tomarla primero para
poder responder** — no alcanza con que esté libre (bug corregido: la primera versión
dejaba responder a cualquiera mientras nadie más la hubiera tomado, sin exigir el paso
de "Tomar"). Todas las rutas que modifican algo (`responder`, `notas`, `adjunto`)
verifican que quien pide sea el agente dueño Y que el estado sea `asignada` — si no,
devuelven `423 Locked`. Tomarla cuando ya está asignada a otro
devuelve `409 Conflict`.

**El problema real que había que resolver: ¿quién es "el agente"?** Todavía no hay
login — la identidad recién existe de verdad con el SSO de GHL (Fase 6). Mientras
tanto (Fases 1–2, que es donde se puede probar esto hoy), `/inbox` pide el nombre una
vez al entrar (`src/app/inbox/page.tsx`), genera un id random, y lo guarda en
`localStorage` — se manda en los headers `x-s24-agente-id` / `x-s24-agente-nombre` en
cada pedido que modifica algo. `src/lib/agente.ts` (`agenteActual`) prioriza siempre el
SSO de GHL si está disponible, y cae a estos headers solo si no lo está — así el mismo
código sirve para las dos etapas sin tener que reescribirlo en la Fase 6.

**Importante — esto NO es autenticación real**, es solo lo mínimo para poder probar el
bloqueo con varias pestañas/navegadores hoy. No reemplaza el control de acceso real que
va a dar GHL más adelante.

## 19. Paridad con Huellas de Paz: adjunto + caption en un solo mensaje, tildes de estado, "escribiendo…"

Pedido explícito tras revisar el inbox de Huellas de Paz: el diseño visual se rehizo
(ver más abajo), y además faltaban tres cosas puntuales que ese proyecto sí tiene.

### 19.1 Adjuntar archivo con texto, como WhatsApp

Antes, elegir un archivo lo mandaba al toque, sin poder escribir nada junto — WhatsApp
deja escribir un texto (caption) que viaja pegado al archivo, en un solo mensaje. Ahora
`/inbox` hace lo mismo: elegir un archivo lo deja "en espera" (un chip con el nombre
arriba del composer, con una `×` para sacarlo), el mismo campo de texto de siempre sirve
de caption, y "Enviar" manda los dos juntos en un solo pedido a
`POST /api/conversaciones/[id]/adjunto` (`caption` como campo extra del `FormData`).

Un caso especial confirmado contra la API de Meta (y replicado de Huellas de Paz): el
**audio no admite caption** — si el agente escribió algo igual, se descarta en el
backend antes de mandarlo a Kapso (`src/app/api/conversaciones/[id]/adjunto/route.ts`),
mismo criterio que usa Meta.

### 19.2 Tildes de enviado/entregado/leído

Se agrega `status?: 'sending'|'sent'|'delivered'|'read'|'failed'` a los mensajes
salientes (`src/lib/mensaje.ts`). Igual que Huellas de Paz, son caracteres Unicode
(`✓` / `✓✓`) con `letter-spacing` negativo para que las dos tildes se vean pegadas como
en WhatsApp real, no un ícono/SVG — la tilde de "leído" se pinta de celeste
(`--read-tick`).

**Cómo se entera el sistema del cambio de estado:** en `STANDALONE_MODE`, Kapso manda un
webhook aparte por cada cambio (`x-webhook-event: whatsapp.message.status` o
`whatsapp.message.sent/delivered/read/failed`), con el id del mensaje en `message.id` y
el estado en `message.kapso.status` — confirmado contra el código en producción de
Huellas de Paz (`procesarStatusUpdate` en su webhook). `src/lib/standalone/store.ts`
(`actualizarEstadoMensaje`) busca ese id entre los mensajes guardados (por eso ahora
también se guarda el `waId` que devuelve Kapso al mandar) y actualiza el tick; el evento
SSE avisa al navegador para que se vea al instante.

En **DEMO_MODE** no hay ningún Kapso real que mande ese webhook, así que se simula:
cada mensaje saliente nuevo pasa de `sent` a `delivered` (~1.2s) a `read` (~3.5s)
automáticamente (`src/lib/demo/store.ts`), disparando el mismo evento SSE — es lo único
de este punto que es pura puesta en escena, no algo que vaya a pasar igual en producción
(en producción los tiempos dependen de cuándo el cliente realmente lee el mensaje).

### 19.3 Indicador de "escribiendo…"

**Aclaración importante, porque puede prestarse a confusión:** ni en Huellas de Paz ni
acá existe un indicador de "el CLIENTE está escribiendo" visible en el inbox — la
WhatsApp Business Platform no le informa eso al negocio, solo funciona al revés. Lo que
Huellas de Paz tiene (y ahora esto también) es: cuando el AGENTE empieza a escribir una
respuesta, el backend le avisa a Meta que le muestre al cliente, en su propio WhatsApp,
el típico "escribiendo…" — usando la API de `typing_indicator` de Meta, que de paso
marca como leído el último mensaje entrante.

`src/lib/kapso/client.ts` (`enviarIndicadorEscribiendo`) manda
`POST {phoneNumberId}/messages` con
`{ messaging_product, status: 'read', message_id, typing_indicator: { type: 'text' } }`
— necesita el `waId` del último mensaje ENTRANTE de esa conversación
(`ultimoMensajeEntranteWaId` en `src/lib/standalone/store.ts`), por eso ahora los
mensajes entrantes también guardan su `waId` (`message.id`, capturado en
`parsearMensajeEntrante`). El frontend dispara esto en cada tecla que se escribe en el
composer, pero limitado a como mucho una vez cada 20s por conversación
(`src/app/inbox/page.tsx`, mismo throttle que usa Huellas de Paz — el indicador dura
~25s del lado del cliente). Solo tiene efecto real en `STANDALONE_MODE`; en `DEMO_MODE`
no hay ningún teléfono real del otro lado, así que la ruta
`/api/conversaciones/[id]/typing` no hace nada.

### 19.4 Grabar y mandar audio (nota de voz)

Faltaba la pieza más obvia de "paridad con Huellas de Paz": grabar un audio con el
micrófono y mandarlo, no solo adjuntar un archivo de audio ya existente desde el disco.
Se portó la implementación de Huellas de Paz casi tal cual (`src/app/inbox/page.tsx`,
funciones `iniciarGrabacion`/`detenerYEnviarGrabacion`/`cancelarGrabacion`):

- **Por qué no alcanza con `MediaRecorder` (la API "obvia" del navegador):** produce
  WebM o MP4 **fragmentado**, y WhatsApp lo rechaza en silencio (no da error, el audio
  simplemente no se reproduce del otro lado) — confirmado por Huellas de Paz en
  producción. Por eso se arma el MP3 a mano: Web Audio API (`AudioContext` +
  `ScriptProcessorNode`) captura el PCM crudo del micrófono, y
  [`@breezystack/lamejs`](https://www.npmjs.com/package/@breezystack/lamejs) lo
  codifica a un MP3 estándar de verdad, mismo paquete y misma configuración
  (44.1kHz, mono, 128kbps) que usa Huellas de Paz.
- El botón de mic reemplaza al de "Enviar" cuando el campo de texto está vacío y no hay
  ningún archivo adjunto en espera (igual que en WhatsApp real) — al empezar a grabar,
  todo el composer cambia a un modo de grabación: botón de cancelar, punto rojo
  pulsante + cronómetro, botón de enviar.
- Al terminar de grabar, el MP3 resultante se manda por el mismo camino que cualquier
  otro adjunto (`subirArchivo` → `POST /api/conversaciones/[id]/adjunto`) — no hizo
  falta una ruta ni un almacenamiento aparte, a diferencia de Huellas de Paz (que sube
  el audio a Supabase Storage para conseguirle una URL pública): acá alcanza con la
  subida directa a la API de medios de Kapso que ya existía para el resto de los
  adjuntos (ver §17), porque Kapso no necesita un link público — se manda por `id` de
  media subido.
- Maneja el permiso del micrófono explícitamente: si el navegador lo bloquea o no hay
  micrófono, se muestra un aviso claro (con opción de "Permitir" si todavía no se le
  preguntó al usuario) en vez de fallar en silencio.

### 19.5 Rediseño visual

Se revisó `D:\HuellasDePaz\HuellasDePaz\crm` (su pantalla de inbox) como referencia
directa tras el segundo pedido de rediseño. Cambios concretos en
`src/app/inbox/inbox.css`: burbujas salientes con gradiente teal (antes color plano),
esquina "cola" más marcada (16px con 4px del lado del emisor, igual que WhatsApp real),
avatares con gradiente en vez de un tinte plano, ítems de conversación con una barra de
acento a la izquierda cuando están activos/seleccionados, botones y el composer con
forma de píldora/circulares en vez de rectangulares, y más aire/sombra en general. La
estructura de 3 columnas (números/lista/hilo) se mantiene tal cual — es una diferencia
real y necesaria frente a Huellas de Paz (que solo tiene un número), no un descuido de
diseño.

## 20. Traspasar una conversación a otro agente

Pedido explícito: además de tomar/liberar/cerrar (§18), hace falta poder pasarle
directamente una conversación a otro agente en concreto — un traspaso real, no "liberar
y que la agarre quien pase primero".

**El problema a resolver:** para traspasarle una conversación a "Marcos", hace falta el
`id` que el navegador/localStorage de Marcos genera y manda en sus propios pedidos
(`x-s24-agente-id`) — no alcanza con escribir su nombre a mano, porque si el id no
coincide con el que su sesión realmente usa, después Marcos no puede responder (la
verificación de dueño es por id, no por nombre). Como todavía no hay un directorio de
usuarios real (eso lo va a dar GHL en la Fase 6), se arma uno mínimo en memoria:

- `src/lib/agentesConocidos.ts` — un `Map` en memoria de agentes que ya se
  identificaron alguna vez. `src/lib/agente.ts` (`agenteActual`) registra ahí a
  cualquiera que pase por una ruta con sus headers de identidad.
- `GET /api/agentes` devuelve la lista — y de paso, llamarla registra a quien la llama
  (así con solo tener el inbox abierto ya aparecés como destino posible para los demás,
  sin tener que haber tomado nada todavía). El frontend la pollea cada 45s
  (`POLL_RESPALDO_MS`, mismo intervalo que conversaciones/mensajes).
- `POST /api/conversaciones/[id]/traspasar` — solo lo puede hacer el dueño actual
  (mismo chequeo de `puedeEscribir`/`asignadaA.id` que el resto de las rutas). A
  diferencia de "liberar", la conversación queda `asignada` todo el tiempo, nunca pasa
  por `sin_asignar` — nadie más puede agarrarla de pasada en el medio del traspaso.
- En el hilo, el selector "Traspasar a…" solo aparece si hay algún otro agente conocido
  además de uno mismo — si sos el único que usó el inbox hasta ahora, no tiene sentido
  mostrarlo.

Mismo criterio que el resto de §18: esto es lo mínimo para poder probar el traspaso hoy,
no reemplaza el directorio de usuarios real que va a dar GHL.

## 21. Identidad visual propia por número ("skins")

Feedback explícito: la pantalla se sentía genérica, como cualquier inbox — y Dealers /
Abonados / App Full Control no son 3 filtros de un mismo canal, son 3 líneas de negocio
distintas. Se le dio a cada número su propio color + ícono
(`src/app/inbox/page.tsx`, array `NUMEROS`), y ese color se propaga a todo lo que se ve
mientras estás parado en ese número: la fila activa en el nav, la conversación
seleccionada, las burbujas salientes, el botón de enviar y los avatares.

- Dealers → ámbar (`#c9852e`), ícono de maletín.
- Abonados → teal (`#14a79e`, el color de marca por defecto), ícono de escudo (coherente
  con que Security24 es una empresa de monitoreo).
- App Full Control → violeta (`#6d63c9`), ícono de celular.

**Cómo se implementó (sin duplicar CSS por color):** una sola custom property CSS,
`--numero-accent` (+ variantes `-dim`/`-tint`), definida en `.s24-inbox` con el teal como
default. Cualquier elemento marcado con `data-numero="dealers|abonados|fullcontrol"`
pisa esa variable con el color de ese número — el panel entero (`.s24-console`) lleva el
atributo seteado al número activo, así que todo lo que hay adentro (lista, hilo,
burbujas, botón enviar) hereda el color en cascada sin que cada regla tenga que saber
qué número es. Las 3 pastillas de estado del header, en cambio, llevan cada una su
propio `data-numero` fijo (no el del número activo) para mostrar los 3 colores a la vez,
todo el tiempo, aunque estés parado en otro número.

## 22. Filtro por agente ("¿qué tiene tomado Fulano?")

Pedido explícito: un selector para ver de un vistazo qué conversaciones tiene tomadas un
agente en particular — va arriba de la lista de conversaciones (no en la barra superior
global, primer lugar donde se probó — feedback directo: "arriba de los chats"). Reutiliza
el mismo directorio de agentes conocidos que ya existía para el traspaso (§20,
`GET /api/agentes`) — nada nuevo que mantener ahí.

Es un filtro **puramente del lado del cliente**, sobre las conversaciones ya cargadas
del número activo (`src/app/inbox/page.tsx`, `conversacionesFiltradas`): compara
`c.asignadaA?.id` contra el agente elegido. Queda con alcance por número a propósito —
no agrega un fetch nuevo cruzando los 3 números a la vez, así que para ver lo que un
agente tiene tomado en Dealers y en Abonados hay que mirar cada número por separado
cambiando de pestaña (el filtro se mantiene aplicado al cambiar de número). Si el
volumen de conversaciones creciera mucho y esto se sintiera limitado, ahí sí valdría la
pena un endpoint agregado del lado del servidor — no hace falta todavía.

## 23. Auditoría — bug encontrado y corregido: el bloqueo no era real del lado del servidor

Pedido explícito: una auditoría completa del proyecto. El hallazgo más importante:
**`liberar` y `cerrar` no verificaban quién los pedía.** Se agregaron junto con el resto
del bloqueo entre agentes (§18), pero a diferencia de `responder`/`notas`/`adjunto`/
`asignar`/`traspasar`, nunca llamaban a `agenteActual()` ni chequeaban dueño — cualquiera
con acceso a la API (no hacía falta ser el dueño, ni siquiera estar en la UI) podía
liberar o cerrar la conversación de cualquier otro agente. Confirmado en vivo con curl
antes de corregirlo: un "atacante" sin ninguna relación con la conversación la liberó y
la cerró sin problema. Esto rompía por completo la garantía central del proyecto ("cuando
un agente toma un chat se debe bloquear ese chat").

**Corregido** (`src/lib/standalone/store.ts`, `src/lib/demo/store.ts`,
`.../liberar/route.ts`, `.../cerrar/route.ts`): ambas funciones ahora piden `agenteId` y
verifican que la conversación esté `asignada` a ese mismo agente antes de tocar nada —
si no, `423`. Se re-verificó en vivo: el mismo ataque ahora falla, y el dueño real sigue
pudiendo liberar/cerrar sin problema.

**Segundo hallazgo relacionado:** `asignar` ("Tomar") no rechazaba conversaciones
`cerrada` — se le podía pasar por encima al cierre re-tomando la conversación por API
directa (la UI nunca ofrece el botón "Tomar" en una cerrada, pero el backend no lo
impedía). Corregido: `asignarConversacion`/`asignarConversacionDemo` ahora devuelven
`{ok: false, motivo: 'cerrada'}` si se intenta.

**Tercer hallazgo, menor:** `/api/conversaciones/[id]/typing` tampoco verificaba dueño —
cualquiera podía hacerle llegar un "escribiendo…" (y de paso, marcar como leído el último
mensaje) a un cliente de una conversación que ni tenía tomada. Impacto bajo (no expone ni
corrompe datos, solo un efecto molesto/confuso hacia el cliente), pero corregido por
consistencia con el resto de las rutas.

**Resto de los hallazgos de la auditoría — también corregidos, a pedido explícito de
revisar todo lo que había quedado pendiente:**
- **Rate limiting en las rutas internas.** `responder`, `notas`, `adjunto`, `asignar`,
  `liberar`, `cerrar`, `traspasar` y `typing` solo tenían la validación de origen
  (`x-s24-inbox`), sin ningún límite de ritmo — a diferencia de los 2 webhooks externos.
  Como la identidad de agente en Fases 1–2 es auto-declarada por header (no hay login
  real, ver §18), cualquiera con acceso de red al servidor podía golpear estas rutas sin
  freno. Se agregó `accionLimitada` (`src/lib/rateLimit.ts`): 120 pedidos/minuto por IP y
  por ruta — muy por encima de lo que un humano clickeando llega a generar, pero corta un
  script. Probado con una ráfaga real de 125 pedidos seguidos a `/liberar`: el pedido 121
  en adelante devolvió `429`. **Sigue siendo, ante todo, un riesgo a no exponer a
  internet público antes de que la Fase 6 traiga autenticación real vía GHL** — el rate
  limit ayuda contra un flood, no reemplaza tener identidad real.
- **Límite de tamaño de body antes de bufferear.** `POST /.../adjunto` chequeaba el
  límite de 8MB recién después de `request.formData()` (que ya había leído todo el body a
  memoria). Ahora se corta antes, comparando el header `Content-Length` declarado contra
  el límite (con margen para el overhead del multipart) — probado: un pedido con
  `Content-Length: 20MB` devuelve `413` sin llegar a leer el body.
- **Los 4 errores de eslint** (`react-hooks/set-state-in-effect` ×3,
  `react-hooks/purity` ×1) en `src/app/inbox/page.tsx` — confirmados como patrones
  estándar sin alternativa real (leer localStorage al montar, fetch+poll de datos
  externos, resetear el borrador al cambiar de conversación, `Date.now()` dentro de un
  handler de click, no del render) mal clasificados por una regla nueva y estricta.
  Se documentaron con `eslint-disable-next-line` puntual + comentario explicando por qué,
  en vez de dejarlos sueltos o reescribir código que ya estaba bien. `npx eslint` corre
  limpio ahora (0 errores; quedan solo warnings de perf de `<img>` y una variable sin usar
  en `ghl/client.ts`, ninguno relevante para este proyecto).
- `npm audit`: mismas 6 vulnerabilidades moderadas ya revisadas en §15 (esbuild/postcss,
  herramientas de build/dev, sin exploit posible acá) — sin cambios, no se tocan.
- No se encontraron secretos commiteados: solo `.env.example` está trackeado en git, y
  sus valores están todos vacíos.

## 24. Tres cosas que faltaban en la conexión real con Kapso (coexistencia)

Pedido explícito, comparando contra otro inbox de WhatsApp que ya tiene número real
conectado hace tiempo: había 3 piezas de la conexión real que acá todavía no existían
(los ticks y los campos del payload del webhook ya estaban bien, confirmados desde el
principio contra fuentes reales — ver §16 y §19.2, no hacía falta tocarlos).

### 24.1 Fallback del "escribiendo…" cuando no hay waId guardado

`ultimoMensajeEntranteWaId` solo encuentra el waId si el mensaje se guardó *después* de
que se empezara a trackear ese campo — una conversación con mensajes viejos, o el primer
mensaje de una conversación nueva en un instante muy particular, se quedaría sin poder
mandar el indicador. Se agregó `buscarUltimoMensajeEntranteEnKapso`
(`src/lib/kapso/client.ts`): si no hay waId local, le pregunta directo a Kapso
(`GET {phoneNumberId}/messages?direction=inbound&limit=10&since=...`) y busca el mensaje
cuyo `from`/`kapso.phone_number` termine con el teléfono del contacto. Se usa tanto en
`/typing` como en el punto siguiente.

### 24.2 Marcar como leído al ABRIR una conversación (no solo al escribir)

Antes, la única forma de marcar un mensaje como leído era `enviarIndicadorEscribiendo`
(que además dispara el "escribiendo…") — y esa solo se dispara cuando el agente empieza a
tipear una respuesta. Si un agente abre una conversación para leerla sin necesariamente
responder al toque, el cliente nunca veía el tilde azul. Se separó en dos:
`marcarLeido` (`src/lib/kapso/client.ts`) manda `status: 'read'` **sin**
`typing_indicator`, y se llama automáticamente al seleccionar una conversación
(`src/app/inbox/page.tsx`, mismo efecto que carga los mensajes del hilo) vía la nueva
ruta `POST /api/conversaciones/[id]/marcar-leido`. No exige ser el dueño de la
conversación (a diferencia de responder/notas/adjunto) — es una cortesía de lectura, no
una acción de escritura sujeta al bloqueo entre agentes (§18).

### 24.3 Mensajes mandados desde el celular (coexistencia real)

Este era el hueco más importante: como el número queda en **coexistencia** (§3.1), el
equipo puede seguir contestando desde la app de WhatsApp Business del celular en vez de
desde acá — y antes esos mensajes no aparecían nunca en el inbox propio, dejando el
historial incompleto para cualquiera que lo mirara desde acá.

Kapso manda el mismo evento `whatsapp.message.sent` tanto para confirmar el estado de un
mensaje que mandamos nosotros por API, como para avisar de un mensaje saliente que pasó
por el número por otro medio (el celular) — se distinguen por `message.kapso.direction:
'outbound'` combinado con que el `waId` **no** coincide con ningún mensaje que ya
tengamos guardado (`actualizarEstadoMensaje` devuelve `null`). En ese caso
(`src/app/api/kapso/webhook/route.ts`), en vez de descartarlo se parsea con el mismo
`parsearMensajeEntrante` que ya usa el mensaje entrante (la forma del objeto `message` es
la misma esté el mensaje entrando o saliendo), se busca o crea la conversación, y se
agrega al historial con el body prefijado `[Celular] ` para que el equipo sepa que no
salió desde el inbox. Probado en vivo con dos webhooks firmados simulados: uno crea la
conversación, el segundo (mismo teléfono, `direction: outbound`, waId nuevo) agrega el
mensaje con el prefijo — y un tercero, un `status` update para ESE MISMO waId, actualiza
el tick sin duplicar el mensaje (confirma que el dedup por waId funciona en los dos
sentidos: no duplica lo que ya mandamos nosotros, y tampoco duplica lo que capturó del
celular al llegarle después una confirmación de estado).
