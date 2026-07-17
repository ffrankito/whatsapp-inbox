import type { NumeroId } from '@/lib/ghl/numeros'
import { DEMO_SEED, type DemoConversacion } from './data'

export const DEMO_MODE = process.env.DEMO_MODE === 'true'

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

export function agregarMensajeDemo(conversationId: string, body: string, direction: 'inbound' | 'outbound') {
  const conv = encontrarConversacion(conversationId)
  if (!conv) return null

  const nuevo = { id: nuevoId('demo-msg'), body, direction, dateAdded: new Date().toISOString() }
  conv.mensajes.push(nuevo)
  return nuevo
}

export function agregarNotaDemo(contactId: string, body: string) {
  // En modo demo la nota no se persiste en ningún lado real — alcanza con loguearla,
  // total en la Fase 6 esto pasa a ser un POST /contacts/{id}/notes de verdad en GHL.
  console.log(`[demo] nota para ${contactId}: ${body}`)
}
