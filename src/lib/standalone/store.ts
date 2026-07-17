import type { NumeroId } from '@/lib/ghl/numeros'

// Fase 2 del roadmap: Kapso real conectado, pero todavía sin GHL — se guarda en memoria
// nomás. No hace falta persistencia acá: como el número queda en coexistencia, el
// historial real del mensaje sigue viviendo en la app de WhatsApp del celular igual
// (ver ARCHITECTURE.md §14.2). Esto se descarta en la Fase 6.

export type StandaloneMensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
}

export type StandaloneConversacion = {
  id: string
  numero: NumeroId
  contactId: string
  phone: string
  fullName: string
  mensajes: StandaloneMensaje[]
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
    conv = { id, numero, contactId: id, phone, fullName: nombre ?? phone, mensajes: [] }
    conversaciones.set(id, conv)
  } else if (nombre && conv.fullName === conv.phone) {
    conv.fullName = nombre
  }
  return conv
}

export function agregarMensaje(conversationId: string, body: string, direction: 'inbound' | 'outbound') {
  const conv = conversaciones.get(conversationId)
  if (!conv) return null
  const nuevo = { id: nuevoId('standalone-msg'), body, direction, dateAdded: new Date().toISOString() }
  conv.mensajes.push(nuevo)
  return nuevo
}
