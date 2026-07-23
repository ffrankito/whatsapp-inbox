# Backlog — features pendientes

Lista recopilada en conversación, no priorizada todavía por fase del roadmap. Se agrega
acá tal cual salió, para no perderla — cuando se arranque a implementar algo de esto, se
mueve al `ROADMAP.md` en la fase que corresponda.

## Login y sesión

1. Login con Google (`@security24.com.ar`) — reemplaza el gate de "¿Quién sos?", temporal
   hasta que llegue el SSO de GHL en la Fase 6.
2. Auto-liberar una conversación si queda sin actividad mucho tiempo (agente se fue y no
   la liberó). El botón de "forzar liberar" manual queda descartado por ahora.

## Mensajería / WhatsApp

3. Transcripción de audio (en vez de guardar el audio entero) — pendiente decidir Whisper
   autohospedado (gratis, más infra) vs API paga (casi gratis, mucho más simple).
4. Saludo automático con el nombre del agente al tomar una conversación.
5. Aviso al cliente cuando se traspasa la conversación a otro agente.
6. ~~Mensajes de plantilla (HSM) para reabrir conversaciones fuera de la ventana de 24hs
   de WhatsApp~~ — **hecho para Full App**: plantilla `reabrir_conversacion` aprobada por
   Meta (`APPROVED`, categoría final `MARKETING` — Meta la recategorizó de UTILITY
   durante la revisión, id `887680860605104`, WABA `191950227325628`, idioma `es_AR`,
   parámetro NAMED `nombre`). `enviarPlantillaPorKapso` en kapso/client.ts, botón
   "Iniciar conversación" en la Agenda para contactos sin chat, y en el hilo mismo un
   banner rojo "Ventana cerrada" con una fila de plantillas rápidas (una por ahora) para
   reactivar una conversación existente que ya pasó las 24hs — mismo patrón que Aires de
   Paz. `NumeroWhatsapp.plantillasRapidas` es un array (no una sola), configurado vía env
   vars numeradas `WA_<PREFIX>_TEMPLATE_<n>_*` — se pueden sumar más plantillas sin tocar
   código. `GET /api/plantillas` para que el frontend sepa cuáles hay por número, `POST
   /api/contactos/[waId]/conversacion` (con `plantillaId`) para mandarla. Falta repetir
   el trámite de aprobación en Meta para Dealers y Abonados, y reescribir el texto para
   apuntar a UTILITY (MARKETING sale más caro) — ver charla sobre esto.
7. Mensaje automático fuera de horario de atención — distinto según si se detecta algo
   urgente (ver #9), configurable por línea de negocio y por horario/feriados; si es
   urgente, escalar de verdad a un celular de guardia, no solo dejarlo en la cola.
8. Notificaciones de llamadas por WhatsApp (Kapso soporta la Calling API) — falta
   confirmar que funcione igual en modo coexistencia antes de construir algo.

## Triage / organización de conversaciones

9. Detección de palabras clave urgentes ("alarma", "robo", "emergencia") para priorizar
   automáticamente esa conversación.
10. Etiquetas de estado por conversación (Urgente / Esperando / Resuelto) — ya estaba en
    el mockup original (`docs/preview.html`) pero nunca se construyó de verdad.
11. Respuestas rápidas / plantillas de texto por línea de negocio (Dealers/Abonados/Full
    App).
12. Buscador de conversaciones por nombre/teléfono/texto.

## Auditoría / exportación

13. Exportar historial de una conversación (o en lote por fecha/agente) con metadata
    completa (quién respondió, timestamps, estado de entrega), en PDF con membrete de la
    empresa.

## Seguridad y confiabilidad (ya identificados en la revisión, no nuevos)

14. ~~Cerrar los 2 huecos de seguridad~~ — **resueltos los dos**:
    ~~Lectura de conversaciones sin autenticación (IDOR)~~ — `GET /api/conversaciones` y
    `/api/conversaciones/[id]` ahora exigen `agenteActual()` antes de devolver nada.
    ~~Suplantación de agente vía `/api/agentes`~~ — resuelto al agregar el login con
    Google: se sacó el fallback de headers sin verificar (`x-s24-agente-id`/`-nombre`),
    ahora la única identidad válida es una cookie firmada server-side (ver
    src/lib/agente.ts).
15. Logs estructurados + reintentos cuando falla un envío a Kapso/GHL (hoy se pierde en
    silencio).
16. Tests automatizados para la lógica de bloqueo entre agentes y el parser de Kapso.
17. ~~Validación de variables de entorno al arrancar~~ — **hecho**: `src/instrumentation.ts`
    (hook oficial de Next.js, corre una vez al levantar el proceso) valida que estén
    SESSION_SECRET/NEXT_PUBLIC_GOOGLE_CLIENT_ID/GOOGLE_ALLOWED_DOMAIN siempre, más
    DATABASE_URL/KAPSO_APP_SECRET/al menos un número completo en STANDALONE_MODE — si
    falta algo, el proceso ni arranca, en vez de fallar en silencio en medio de una
    prueba (como pasó hoy con SESSION_SECRET). Sin probar en runtime todavía (no se
    corrió local esta noche a pedido explícito) — confirmar en el próximo deploy que
    tira el error esperado si falta algo.
18. Del review de esta noche sobre todo lo que sumó la sesión en paralelo (contactos,
    reacciones, adjuntos guardados en base): **arreglado** un bug real donde los
    documentos entrantes persistidos como `data:` URL volvían a forzar "Guardar como"
    (mismo bug que ya se había resuelto para los que quedan como link de Kapso) — se
    sacó el atributo `download` de esa rama y se armó `src/lib/mime.ts` compartido para
    inferir el Content-Type por extensión en los dos casos. También se agregó el chequeo
    de dueño que le faltaba a `POST /api/contactos/[waId]/conversacion` (cualquier
    agente podía mandarle una plantilla a una conversación tomada por otro).
19. Pendiente, no bloqueante: `src/app/inbox/page.tsx` ya tiene ~1800 líneas — conviene
    partirlo en componentes/hooks separados antes de que siga creciendo, pero es un
    refactor grande que no se hizo esta noche a propósito (riesgo de romper algo justo
    antes de una prueba en vivo).
20. ~~Guardar adjuntos como base64 en Postgres~~ — **hecho**: se mueven a storage de
    objetos propio, **MinIO auto-hospedado en Railway** (no un servicio externo tipo
    R2 — se eligió self-host porque a futuro esto se muda al servidor propio del data
    center de la empresa, Fase 7, y ahí MinIO viaja con la app sin depender de nadie
    externo). `src/lib/storage.ts` nuevo (cliente S3-compatible vía `@aws-sdk/client-s3`,
    endpoint por la red PRIVADA de Railway, bucket privado — nunca un link público
    directo). `adjunto.url` pasa a guardar una referencia interna (`s24storage://<key>`)
    en vez del archivo entero; se sirve siempre a través del mismo `/api/adjunto/proxy`
    ya autenticado que usábamos para los adjuntos de Kapso (ahora también entiende esta
    referencia, además del link externo de Kapso). Se sacó el chequeo de CSRF de esa
    ruta: es un GET de solo lectura sin efecto secundario, y `<img>/<video>/<audio>
    src="..."` no pueden mandar headers custom — sin sacarlo, fotos/audios/videos
    guardados en MinIO nunca hubieran cargado. Mensajes viejos con adjuntos en `data:`
    (de antes de este cambio) se siguen sirviendo igual, sin migración — conviven los dos
    formatos sin romper nada. **Verificado en vivo de punta a punta, subida y bajada**:
    webhook simulado con una imagen real → se bajó, se subió a MinIO (confirmado con
    `HeadObject` directo contra el bucket) → y se vio bien desde `/inbox` de verdad (la
    persona lo abrió en el navegador y confirmó que la imagen se ve normal, no rota ni
    forzando descarga). Datos de prueba limpiados después (Postgres + el archivo en
    MinIO). Sigue pendiente probar documento/audio/video puntualmente (mismo código,
    debería andar igual, pero solo se confirmó con imagen).
