# Roadmap — WhatsApp Inbox Security24

Estado a hoy: el código base está armado y compila limpio (`npm run build` sin errores).

**Orden revisado (segunda vuelta):** antes de invertir en GHL, van dos etapas de
validación por separado — primero el diseño/UX con datos de mentira, después la
conexión real a WhatsApp (vía Kapso) pero todavía como página suelta, sin embeber en
GHL. Recién con las dos aprobadas se integra todo dentro de GHL.

## Fase 0 — Hecho ✅

- Arquitectura investigada y documentada (`docs/ARCHITECTURE.md`).
- Proyecto Next.js 16 + Drizzle + Tailwind scaffoldeado, build limpio.
- Rutas backend escritas: OAuth callback, sesión SSO, webhook de Kapso, Delivery URL de
  GHL, y el CRUD de conversaciones/notas.
- UI de `/inbox` armada (selector de 3 números, lista, hilo, composer, notas).
- Marketplace App creada en el sandbox de developer (`Whatsapp inbox`, Client
  ID/Secret/Shared Secret ya en `.env.local`).
- Sub-cuenta de test creada (location `UnDaROg6tyLshlODU22O`).

## Fase 1 — Demo visual con datos de ejemplo 👈 siguiente

Objetivo: validar el diseño/UX con algo clickeable, antes de conectar nada real.

- [x] "Modo demo" — con `DEMO_MODE=true`, las rutas `/api/conversaciones` y
      `/api/conversaciones/[id]` devuelven datos de ejemplo fijos (mismo contenido de
      `docs/preview.html`: Dealers/Abonados/Full Control con conversaciones de muestra)
      en vez de llamar a GHL. Probado end-to-end (`src/lib/demo/`).
- [x] En modo demo, "Enviar" y "Guardar nota" actualizan el estado en memoria del
      servidor — sin mandar nada real a ningún lado.
- [x] `Dockerfile` multi-stage (`next.config.ts` con `output: 'standalone'`) — probado
      localmente: build OK, contenedor levanta, corre como usuario no-root (`nextjs`), y
      el modo demo respondió bien adentro del contenedor.
- [ ] Publicarlo en un servidor del data center — alcanza con acceso interno/VPN por
      ahora. Ver `docker-compose.yml` (necesita un `.env.production` con las variables de
      `.env.example` completadas).
- [ ] Mostrar internamente y juntar feedback de diseño.

**Punto de decisión:** solo se pasa a la Fase 2 si el diseño se aprueba.

## Fase 2 — Prueba con Kapso real, todavía standalone (sin GHL)

Objetivo: validar que la conexión real a WhatsApp funciona de punta a punta, sin
esperar a tener toda la integración de GHL armada. El `/inbox` sigue siendo una página
suelta (no embebida) en esta etapa.

- [x] **Código**: `STANDALONE_MODE=true` — el webhook de Kapso guarda el mensaje **en
      memoria del proceso** (`src/lib/standalone/store.ts`) en vez de reenviar a GHL, y
      `/responder` manda de verdad por Kapso (`src/lib/kapso/client.ts`) sin pasar por
      GHL. Probado con un webhook simulado firmado correctamente: identifica el número,
      crea la conversación, aparece en `/api/conversaciones`, y el intento de respuesta
      llegó de verdad hasta la API de Kapso (falló solo por credenciales falsas de
      prueba — el error fue un 404 real de Kapso, no un fallo de red/formato).
- [ ] Conectar **uno de los 3 números por Kapso** (o los 3 de una, si se prefiere ir
      directo) vía Embedded Signup, confirmando modo coexistencia — esto lo tenés que
      hacer vos, requiere acceso a Meta Business Manager de Security24.
- [ ] Con el número real conectado: mandar un WhatsApp de verdad y confirmar que aparece
      en `/inbox`, responder desde ahí y confirmar que sale de verdad.
- [ ] **Falta verificar contra un mensaje real**: el parser del webhook de Kapso
      (`whatsapp_config.phone_number_id`, `message.from`, `message.text.body`) está
      armado según su documentación y probado con un payload simulado — falta la
      confirmación final contra un mensaje real de Kapso, puede necesitar un ajuste
      chico de nombres de campo.

**Punto de decisión:** solo se pasa a la Fase 3 (integración con GHL) si esto funciona
bien.

## Fase 3 — Infra real para GHL

- [ ] Crear proyecto Postgres → `DATABASE_URL` (Supabase Cloud o self-hosted en el mismo
      data center, a definir — no cambia código). Recién acá hace falta base de datos de
      verdad, para guardar el token de instalación de GHL.
- [ ] Correr `npm run db:generate` + `npm run db:migrate` para crear `ghl_installs`.
- [ ] Exponer el contenedor con salida pública, detrás de un reverse proxy con TLS → esto
      da el dominio real que falta en varios lugares. **Importante**: configurar el proxy
      para no bufferear `/api/eventos` (rompe el tiempo real si lo hace).
- [ ] Actualizar el **Redirect URL** de la Marketplace App con la URL real.
- [ ] **Código pendiente**: escribir `src/lib/events.ts` (`EventEmitter` compartido en
      memoria) y `src/app/api/eventos/route.ts` (SSE) si no se hizo ya en la Fase 2.

## Fase 4 — Terminar de configurar la Marketplace App en GHL

- [ ] Confirmar que los scopes de **Contacts** (readonly + write) quedaron tildados y
      guardados.
- [ ] Crear los **3 Conversation Providers** (Dealers / Abonados / App Full Control),
      cada uno con su Delivery URL: `https://<dominio>/api/ghl/outbound?numero=<id>` →
      guardar los 3 `conversationProviderId` en `.env.local`.
- [ ] Crear el **Custom Menu Link** (`openMode: iframe`, url = `https://<dominio>/inbox`).
- [ ] Instalar la app sobre la location de sandbox (`UnDaROg6tyLshlODU22O`).

## Fase 5 — Seguridad (cerrar huecos antes de ir en serio)

Se hace acá, antes de que el sistema empiece a manejar datos y acciones reales — no
después. Ver `docs/ARCHITECTURE.md` §15 para el detalle de cada punto.

- [x] **CSRF resuelto**: `/api/conversaciones/[id]/responder` y `.../notas` exigen un
      header propio (`x-s24-inbox`) que solo nuestro frontend manda — un sitio externo
      no puede agregarlo sin disparar un preflight CORS que no autorizamos. Probado:
      pedido sin el header → 403, con el header → funciona normal.
- [x] **Rate limiting resuelto**: `/api/kapso/webhook` y `/api/ghl/outbound` cortan en
      60 pedidos/minuto por IP (`src/lib/rateLimit.ts`). Probado con una ráfaga real: el
      pedido 61 devolvió 429 como se esperaba.
- [x] Revisadas las vulnerabilidades moderadas de `npm audit` — son de herramientas de
      build/dev (esbuild, postcss), sin exploit posible en este proyecto. **No** correr
      `npm audit fix --force`: bajaría Next.js a la v9. Ver ARCHITECTURE.md §15.
- [ ] Definir si hace falta separar por rol quién ve qué número (hoy cualquiera con
      acceso al Custom Menu Link ve los 3), o si alcanza con que todo el equipo comercial
      vea todo.
- [x] Hardening básico del `Dockerfile` ya resuelto desde el arranque: imagen `alpine`
      mínima, el proceso corre como usuario `nextjs` sin privilegios (no root).
- [ ] Confirmar que las notas creadas vía la API quedan con autoría clara en GHL (quién
      la escribió), para que sirvan como auditoría real.

## Fase 6 — Conectar todo: GHL pasa a ser la fuente de verdad

- [ ] Completar la conexión de los números que falten por Kapso (si en la Fase 2 se
      probó solo con uno).
- [ ] **Código**: el webhook de Kapso deja de guardar en memoria y pasa a reenviar a GHL
      (`POST /contacts/upsert` + `POST /conversations/messages/inbound`), como ya estaba
      escrito desde el principio en `src/lib/ghl/client.ts`.
- [ ] Mandar un WhatsApp real → confirmar que aparece en el inbox nativo de GHL y en
      `/inbox`.
- [ ] Responder desde `/inbox` → confirmar que llega de verdad y el estado pasa a
      `delivered` en GHL.
- [ ] Abrir `/inbox` desde el Custom Menu Link **dentro de GHL** → validar SSO sin login.
- [ ] Probar los 3 números en paralelo → confirmar que el selector no los mezcla.
- [ ] Agregar una nota → confirmar que aparece en el contacto en GHL.
- [ ] Confirmar que el aviso en tiempo real sigue funcionando igual que en la Fase 2.

## Fase 7 — Pasar a producción (cuenta real de Security24)

- [ ] Instalar la misma Marketplace App sobre la location real (`QEmYqBPWjjngZgBXZfTf`).
- [ ] Repetir la configuración de Kapso/Delivery URLs para los números reales si son
      distintos de los usados en sandbox.
- [ ] Prueba de humo final con tráfico real de dealers/abonados/Full Control.

## Fase 8 — Después del lanzamiento (no bloqueante)

- Definir si las notas necesitan más estructura que texto libre.
- Vigilar rate limits de la API de GHL bajo uso real de varios agentes a la vez.
- Si en algún momento el contenedor pasa a correr en más de una réplica (balanceo de
  carga), el `EventEmitter` en memoria deja de alcanzar y hay que sumar un intermediario
  compartido (Redis pub/sub) — no hace falta con una sola réplica.
