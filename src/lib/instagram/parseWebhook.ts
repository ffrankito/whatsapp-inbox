export type MensajeInstagramEntrante = {
  cuentaId: string
  senderId: string
  mensajeId: string
  texto: string
}

/**
 * Parsea un payload de webhook de Instagram (object: "instagram", entry[].changes[]
 * con field "messages") — CONFIRMADO contra un evento de prueba real mandado desde el
 * panel de Meta (botón "Probar" del campo `messages`, 23/07/2026):
 *
 * {
 *   "object": "instagram",
 *   "entry": [{ "id": "<cuenta receptora>", "time": ..., "changes": [{
 *     "field": "messages",
 *     "value": {
 *       "sender": { "id": "..." }, "recipient": { "id": "..." },
 *       "timestamp": "...", "message": { "mid": "...", "text": "..." }
 *     }
 *   }] }]
 * }
 *
 * OJO: el evento de prueba de Meta es solo texto — todavía no está confirmado cómo se ve
 * un mensaje con adjunto (imagen/audio/video) ni una reacción, eso hay que confirmarlo
 * contra tráfico real cuando llegue (mismo criterio que se usó con Kapso, ver
 * docs/ARCHITECTURE.md §16).
 */
export function parsearMensajeEntrante(payload: unknown): MensajeInstagramEntrante | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (p.object !== 'instagram') return null

  const entries = Array.isArray(p.entry) ? p.entry : []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const cuentaId = typeof e.id === 'string' ? e.id : undefined
    const changes = Array.isArray(e.changes) ? e.changes : []

    for (const change of changes) {
      if (typeof change !== 'object' || change === null) continue
      const c = change as Record<string, unknown>
      if (c.field !== 'messages') continue

      const value = c.value as Record<string, unknown> | undefined
      const sender = value?.sender as Record<string, unknown> | undefined
      const message = value?.message as Record<string, unknown> | undefined
      const senderId = typeof sender?.id === 'string' ? sender.id : undefined
      const mensajeId = typeof message?.mid === 'string' ? message.mid : undefined
      const texto = typeof message?.text === 'string' ? message.text : undefined

      if (cuentaId && senderId && mensajeId && texto) {
        return { cuentaId, senderId, mensajeId, texto }
      }
    }
  }

  return null
}
