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
6. Mensajes de plantilla (HSM) para reabrir conversaciones fuera de la ventana de 24hs de
   WhatsApp.
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

14. Cerrar los 2 huecos de seguridad: lectura de conversaciones sin autenticación (IDOR)
    + suplantación de agente vía `/api/agentes`.
15. Logs estructurados + reintentos cuando falla un envío a Kapso/GHL (hoy se pierde en
    silencio).
16. Tests automatizados para la lógica de bloqueo entre agentes y el parser de Kapso.
17. Validación de variables de entorno al arrancar (falla rápido y claro si falta algo).
