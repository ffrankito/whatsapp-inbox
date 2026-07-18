import type { NumeroId } from '@/lib/ghl/numeros'
import type { Adjunto, EstadoMensaje } from '@/lib/mensaje'

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
  status?: EstadoMensaje
  waId?: string
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
  opts: { status?: EstadoMensaje; waId?: string } = {},
) {
  const conv = conversaciones.get(conversationId)
  if (!conv) return null
  const nuevo: StandaloneMensaje = {
    id: nuevoId('standalone-msg'),
    body,
    direction,
    dateAdded: new Date().toISOString(),
    adjunto,
    status: direction === 'outbound' ? (opts.status ?? 'sent') : undefined,
    waId: opts.waId,
  }
  conv.mensajes.push(nuevo)
  return nuevo
}

// Cruza el `waId` que devuelve un webhook de estado de Kapso (`message.id`) contra los
// mensajes salientes guardados, para actualizar el tick de "enviado/entregado/leído"
// (ver ARCHITECTURE.md §19). Devuelve el número (canal) al que pertenece, para poder
// emitir el evento SSE con el scope correcto.
export function actualizarEstadoMensaje(waId: string, status: EstadoMensaje): { numero: NumeroId } | null {
  for (const conv of conversaciones.values()) {
    const msg = conv.mensajes.find((m) => m.waId === waId)
    if (msg) {
      msg.status = status
      return { numero: conv.numero }
    }
  }
  return null
}

// Para el indicador de "escribiendo…": Meta requiere el id del último mensaje ENTRANTE
// para poder mostrarle a ese contacto que le estamos por responder (ver ARCHITECTURE.md §19).
export function ultimoMensajeEntranteWaId(conv: StandaloneConversacion): string | undefined {
  for (let i = conv.mensajes.length - 1; i >= 0; i--) {
    const m = conv.mensajes[i]
    if (m.direction === 'inbound' && m.waId) return m.waId
  }
  return undefined
}

// ── Asignación / bloqueo entre agentes ──────────────────────────────────────
// Mientras una conversación está "asignada", solo el agente dueño puede responder o
// agregar notas — el resto de la UI (y las rutas) lo bloquean (ver ARCHITECTURE.md).

export type ResultadoAsignacion = { ok: true } | { ok: false; motivo: 'no_existe' | 'ya_asignada' | 'cerrada'; asignadaA?: Agente }

// Hay que TOMAR la conversación antes de poder responder — no alcanza con que esté
// libre. Antes esto dejaba responder a cualquiera mientras nadie más la hubiera tomado,
// que no es lo que se pidió (bloqueo real: primero tomar, después escribir).
export function puedeEscribir(conv: StandaloneConversacion, agenteId: string): boolean {
  if (conv.estado !== 'asignada') return false
  return conv.asignadaA?.id === agenteId
}

export function asignarConversacion(id: string, agente: Agente): ResultadoAsignacion {
  const conv = conversaciones.get(id)
  if (!conv) return { ok: false, motivo: 'no_existe' }
  if (conv.estado === 'cerrada') return { ok: false, motivo: 'cerrada' }
  if (conv.estado === 'asignada' && conv.asignadaA?.id !== agente.id) {
    return { ok: false, motivo: 'ya_asignada', asignadaA: conv.asignadaA }
  }
  conv.estado = 'asignada'
  conv.asignadaA = agente
  return { ok: true }
}

// Solo el dueño actual puede liberar/cerrar — antes esto lo podía hacer cualquiera (sin
// chequear agenteId), lo que rompía por completo la garantía de bloqueo (§18): cualquiera
// podía sacarle a otro agente una conversación tomada, o cerrarla, sin su consentimiento.
export function liberarConversacion(id: string, agenteId: string): boolean {
  const conv = conversaciones.get(id)
  if (!conv || conv.estado !== 'asignada' || conv.asignadaA?.id !== agenteId) return false
  conv.estado = 'sin_asignar'
  conv.asignadaA = undefined
  return true
}

export function cerrarConversacion(id: string, agenteId: string): boolean {
  const conv = conversaciones.get(id)
  if (!conv || conv.estado !== 'asignada' || conv.asignadaA?.id !== agenteId) return false
  conv.estado = 'cerrada'
  return true
}

export type ResultadoTraspaso = { ok: true } | { ok: false; motivo: 'no_existe' | 'no_sos_dueño' }

// El dueño actual le pasa la conversación directo a otro agente (queda 'asignada' todo
// el tiempo, sin pasar por 'sin_asignar' en el medio) — a diferencia de liberar, nadie
// más puede agarrarla de pasada durante el traspaso.
export function traspasarConversacion(id: string, deAgenteId: string, destino: Agente): ResultadoTraspaso {
  const conv = conversaciones.get(id)
  if (!conv) return { ok: false, motivo: 'no_existe' }
  if (conv.estado !== 'asignada' || conv.asignadaA?.id !== deAgenteId) {
    return { ok: false, motivo: 'no_sos_dueño' }
  }
  conv.asignadaA = destino
  return { ok: true }
}
