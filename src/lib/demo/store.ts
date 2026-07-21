import type { NumeroId } from '@/lib/ghl/numeros'
import type { Adjunto } from '@/lib/mensaje'
import type { Agente, ResultadoAsignacion } from '@/lib/standalone/store'
import { DEMO_SEED, type DemoConversacion, type DemoMensaje } from './data'
import { emitirEvento } from '@/lib/events'

export { DEMO_MODE } from '@/lib/mode'

// Estado en memoria del proceso — se resetea si se reinicia el server. Es intencional:
// ver ARCHITECTURE.md §14.1, es solo para la Fase 1 del roadmap (demo visual).
const estado: Record<NumeroId, DemoConversacion[]> = JSON.parse(JSON.stringify(DEMO_SEED))

let contador = 0
function nuevoId(prefijo: string) {
  contador += 1
  return `${prefijo}-${Date.now()}-${contador}`
}

export function listarConversaciones(numero: NumeroId): DemoConversacion[] {
  return estado[numero]
}

function encontrarConversacion(id: string): DemoConversacion | undefined {
  for (const numero of Object.keys(estado) as NumeroId[]) {
    const conv = estado[numero].find((c) => c.id === id)
    if (conv) return conv
  }
  return undefined
}

export function obtenerConversacion(id: string): DemoConversacion | undefined {
  return encontrarConversacion(id)
}

export function agregarMensajeDemo(conversationId: string, body: string, direction: 'inbound' | 'outbound', adjunto?: Adjunto) {
  const conv = encontrarConversacion(conversationId)
  if (!conv) return null

  const nuevo: DemoMensaje = {
    id: nuevoId('demo-msg'),
    body,
    direction,
    dateAdded: new Date().toISOString(),
    adjunto,
    status: direction === 'outbound' ? 'sent' : undefined,
  }
  conv.mensajes.push(nuevo)

  // Solo para que la demo se vea "viva" sin conectar nada real: simula el mismo
  // recorrido de tildes que en STANDALONE_MODE vendría de un webhook de estado real de
  // Kapso (ver ARCHITECTURE.md §19) — no representa nada que haya pasado de verdad.
  if (direction === 'outbound') {
    const numero = numeroDeConversacionDemo(conv)
    setTimeout(() => {
      nuevo.status = 'delivered'
      emitirEvento({ tipo: 'mensaje', numero })
    }, 1200)
    setTimeout(() => {
      nuevo.status = 'read'
      emitirEvento({ tipo: 'mensaje', numero })
    }, 3500)
  }

  return nuevo
}

function numeroDeConversacionDemo(conv: DemoConversacion): NumeroId {
  for (const numero of Object.keys(estado) as NumeroId[]) {
    if (estado[numero].includes(conv)) return numero
  }
  return 'dealers'
}

// Mismo criterio que en standalone/store.ts: "leído" es de la conversación, no de quién
// la mira — se guarda en el mismo objeto en memoria, así que ya es compartido entre
// cualquiera que pegue contra este proceso (no hay nada por navegador acá).
export function marcarConversacionVistaDemo(id: string, mensajeId: string): boolean {
  const conv = encontrarConversacion(id)
  if (!conv) return false
  conv.vistoHastaMensajeId = mensajeId
  return true
}

export function agregarNotaDemo(contactId: string, body: string) {
  // En modo demo la nota no se persiste en ningún lado real — alcanza con loguearla,
  // total en la Fase 6 esto pasa a ser un POST /contacts/{id}/notes de verdad en GHL.
  console.log(`[demo] nota para ${contactId}: ${body}`)
}

// ── Asignación / bloqueo entre agentes (misma API que lib/standalone/store) ─

// Hay que TOMAR la conversación antes de poder responder — no alcanza con que esté
// libre (ver el mismo comentario en src/lib/standalone/store.ts).
export function puedeEscribirDemo(conv: DemoConversacion, agenteId: string): boolean {
  if (conv.estado !== 'asignada') return false
  return conv.asignadaA?.id === agenteId
}

export function asignarConversacionDemo(id: string, agente: Agente): ResultadoAsignacion {
  const conv = encontrarConversacion(id)
  if (!conv) return { ok: false, motivo: 'no_existe' }
  if (conv.estado === 'cerrada') return { ok: false, motivo: 'cerrada' }
  if (conv.estado === 'asignada' && conv.asignadaA?.id !== agente.id) {
    return { ok: false, motivo: 'ya_asignada', asignadaA: conv.asignadaA }
  }
  conv.estado = 'asignada'
  conv.asignadaA = agente
  return { ok: true }
}

// Solo el dueño actual puede liberar/cerrar (mismo fix que src/lib/standalone/store.ts —
// antes cualquiera podía sacarle a otro agente una conversación tomada, sin su consentimiento).
export function liberarConversacionDemo(id: string, agenteId: string): boolean {
  const conv = encontrarConversacion(id)
  if (!conv || conv.estado !== 'asignada' || conv.asignadaA?.id !== agenteId) return false
  conv.estado = 'sin_asignar'
  conv.asignadaA = undefined
  return true
}

export function cerrarConversacionDemo(id: string, agenteId: string): boolean {
  const conv = encontrarConversacion(id)
  if (!conv || conv.estado !== 'asignada' || conv.asignadaA?.id !== agenteId) return false
  conv.estado = 'cerrada'
  return true
}

export type ResultadoTraspaso = { ok: true } | { ok: false; motivo: 'no_existe' | 'no_sos_dueño' }

export function traspasarConversacionDemo(id: string, deAgenteId: string, destino: Agente): ResultadoTraspaso {
  const conv = encontrarConversacion(id)
  if (!conv) return { ok: false, motivo: 'no_existe' }
  if (conv.estado !== 'asignada' || conv.asignadaA?.id !== deAgenteId) {
    return { ok: false, motivo: 'no_sos_dueño' }
  }
  conv.asignadaA = destino
  return { ok: true }
}
