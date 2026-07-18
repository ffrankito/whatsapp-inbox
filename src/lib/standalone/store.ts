import type { NumeroId } from '@/lib/ghl/numeros'
import type { Adjunto } from '@/lib/mensaje'

// Fase 2 del roadmap: Kapso real conectado, pero todavía sin GHL — se guarda en memoria
// nomás. No hace falta persistencia acá: como el número queda en coexistencia, el
// historial real del mensaje sigue viviendo en la app de WhatsApp del celular igual
// (ver ARCHITECTURE.md §14.2). Esto se descarta en la Fase 6.

export type Agente = { id: string; nombre: string }
export type EstadoConversacion = 'sin_asignar' | 'asignada' | 'cerrada'

export type StandaloneMensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
}

export type StandaloneConversacion = {
  id: string
  numero: NumeroId
  contactId: string
  phone: string
  fullName: string
  mensajes: StandaloneMensaje[]
  estado: EstadoConversacion
  asignadaA?: Agente
}

const conversaciones = new Map<string, StandaloneConversacion>()
let contador = 0

function nuevoId(prefijo: string) {
  contador += 1
  return `${prefijo}-${Date.now()}-${contador}`
}

function idParaTelefono(numero: NumeroId, phone: string) {
  return `standalone-${numero}-${phone.replace(/\D/g, '')}`
}

export function listarConversaciones(numero: NumeroId): StandaloneConversacion[] {
  return [...conversaciones.values()]
    .filter((c) => c.numero === numero)
    .sort((a, b) => (b.mensajes.at(-1)?.dateAdded ?? '').localeCompare(a.mensajes.at(-1)?.dateAdded ?? ''))
}

export function obtenerConversacion(id: string): StandaloneConversacion | undefined {
  return conversaciones.get(id)
}

export function encontrarOCrearConversacion(numero: NumeroId, phone: string, nombre?: string): StandaloneConversacion {
  const id = idParaTelefono(numero, phone)
  let conv = conversaciones.get(id)
  if (!conv) {
    conv = { id, numero, contactId: id, phone, fullName: nombre ?? phone, mensajes: [], estado: 'sin_asignar' }
    conversaciones.set(id, conv)
  } else if (nombre && conv.fullName === conv.phone) {
    conv.fullName = nombre
  }
  return conv
}

export function agregarMensaje(
  conversationId: string,
  body: string,
  direction: 'inbound' | 'outbound',
  adjunto?: Adjunto,
) {
  const conv = conversaciones.get(conversationId)
  if (!conv) return null
  const nuevo = { id: nuevoId('standalone-msg'), body, direction, dateAdded: new Date().toISOString(), adjunto }
  conv.mensajes.push(nuevo)
  return nuevo
}

// ── Asignación / bloqueo entre agentes ──────────────────────────────────────
// Mientras una conversación está "asignada", solo el agente dueño puede responder o
// agregar notas — el resto de la UI (y las rutas) lo bloquean (ver ARCHITECTURE.md).

export type ResultadoAsignacion = { ok: true } | { ok: false; motivo: 'no_existe' | 'ya_asignada'; asignadaA?: Agente }

export function puedeEscribir(conv: StandaloneConversacion, agenteId: string): boolean {
  if (conv.estado === 'cerrada') return false
  if (conv.estado === 'sin_asignar') return true
  return conv.asignadaA?.id === agenteId
}

export function asignarConversacion(id: string, agente: Agente): ResultadoAsignacion {
  const conv = conversaciones.get(id)
  if (!conv) return { ok: false, motivo: 'no_existe' }
  if (conv.estado === 'asignada' && conv.asignadaA?.id !== agente.id) {
    return { ok: false, motivo: 'ya_asignada', asignadaA: conv.asignadaA }
  }
  conv.estado = 'asignada'
  conv.asignadaA = agente
  return { ok: true }
}

export function liberarConversacion(id: string) {
  const conv = conversaciones.get(id)
  if (!conv) return
  conv.estado = 'sin_asignar'
  conv.asignadaA = undefined
}

export function cerrarConversacion(id: string) {
  const conv = conversaciones.get(id)
  if (!conv) return
  conv.estado = 'cerrada'
}
