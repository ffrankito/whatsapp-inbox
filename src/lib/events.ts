import { EventEmitter } from 'events'
import type { NumeroId } from '@/lib/ghl/numeros'

// Pub/sub en memoria — funciona porque corre como proceso Docker persistente, no
// serverless (ver ARCHITECTURE.md §5.1). Los webhooks emiten acá, /api/eventos (SSE)
// reenvía al navegador.

export type InboxEvent = {
  tipo: 'mensaje' | 'estado'
  numero: NumeroId
}

const emitter = new EventEmitter()
emitter.setMaxListeners(0) // puede haber muchas conexiones SSE concurrentes

export function emitirEvento(evento: InboxEvent) {
  emitter.emit('evento', evento)
}

export function suscribirse(cb: (evento: InboxEvent) => void): () => void {
  emitter.on('evento', cb)
  return () => emitter.off('evento', cb)
}
