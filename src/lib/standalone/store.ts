import { randomUUID } from 'node:crypto'
import { and, desc, eq, ne, or } from 'drizzle-orm'
import { db } from '@/db'
import { conversacionesStandalone, mensajesStandalone } from '@/db/schema'
import type { NumeroId } from '@/lib/ghl/numeros'
import type { Adjunto, EstadoMensaje } from '@/lib/mensaje'

// Fase 2 del roadmap: Kapso real conectado, pero todavía sin GHL. Guardado en Postgres
// (adelantado desde la Fase 3 porque las pruebas en vivo lo necesitaban — ver
// ARCHITECTURE.md §32) en vez de en memoria del proceso, así no se pierde con cada
// redeploy/reinicio. Se descarta en la Fase 6, cuando GHL pasa a ser la fuente de verdad.

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
  reaccion?: string
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
  ultimoAgente?: Agente
  vistoHastaMensajeId?: string
}

// Resumen liviano para la lista — no trae todos los mensajes, solo el último (lo único
// que se muestra ahí), para no traer de la base más de lo que hace falta.
export type StandaloneConversacionResumen = Omit<StandaloneConversacion, 'mensajes'> & {
  ultimoMensaje?: StandaloneMensaje
}

// Exportada para la agenda de contactos (ver /api/contactos/[waId]/conversacion) —
// deriva el id de conversación de forma determinística a partir del waId de un
// contacto de Kapso, sin necesitar una query aparte para "buscar por teléfono".
export function idParaTelefono(numero: NumeroId, phone: string) {
  return `standalone-${numero}-${phone.replace(/\D/g, '')}`
}

function aAgente(id: string | null, nombre: string | null): Agente | undefined {
  return id && nombre ? { id, nombre } : undefined
}

function aStandaloneMensaje(row: typeof mensajesStandalone.$inferSelect): StandaloneMensaje {
  return {
    id: row.id,
    body: row.body,
    direction: row.direction as 'inbound' | 'outbound',
    dateAdded: row.dateAdded.toISOString(),
    adjunto: (row.adjunto as Adjunto | null) ?? undefined,
    status: (row.status as EstadoMensaje | null) ?? undefined,
    waId: row.waId ?? undefined,
    reaccion: row.reaccion ?? undefined,
  }
}

function aConversacionBase(row: typeof conversacionesStandalone.$inferSelect): Omit<StandaloneConversacion, 'mensajes'> {
  return {
    id: row.id,
    numero: row.numero as NumeroId,
    contactId: row.contactId,
    phone: row.phone,
    fullName: row.fullName,
    estado: row.estado as EstadoConversacion,
    asignadaA: aAgente(row.asignadaAId, row.asignadaANombre),
    ultimoAgente: aAgente(row.ultimoAgenteId, row.ultimoAgenteNombre),
    vistoHastaMensajeId: row.vistoHastaMensajeId ?? undefined,
  }
}

export async function listarConversaciones(numero: NumeroId): Promise<StandaloneConversacionResumen[]> {
  const filas = await db()
    .select()
    .from(conversacionesStandalone)
    .where(eq(conversacionesStandalone.numero, numero))
    .orderBy(desc(conversacionesStandalone.actualizadoEn))

  return Promise.all(
    filas.map(async (fila) => {
      const [ultimo] = await db()
        .select()
        .from(mensajesStandalone)
        .where(eq(mensajesStandalone.conversacionId, fila.id))
        .orderBy(desc(mensajesStandalone.dateAdded))
        .limit(1)
      return { ...aConversacionBase(fila), ultimoMensaje: ultimo ? aStandaloneMensaje(ultimo) : undefined }
    }),
  )
}

export async function obtenerConversacion(id: string): Promise<StandaloneConversacion | undefined> {
  const [fila] = await db().select().from(conversacionesStandalone).where(eq(conversacionesStandalone.id, id))
  if (!fila) return undefined
  const mensajes = await db()
    .select()
    .from(mensajesStandalone)
    .where(eq(mensajesStandalone.conversacionId, id))
    .orderBy(mensajesStandalone.dateAdded)
  return { ...aConversacionBase(fila), mensajes: mensajes.map(aStandaloneMensaje) }
}

export async function encontrarOCrearConversacion(numero: NumeroId, phone: string, nombre?: string): Promise<StandaloneConversacion> {
  const id = idParaTelefono(numero, phone)
  const [existente] = await db().select().from(conversacionesStandalone).where(eq(conversacionesStandalone.id, id))

  if (!existente) {
    const nueva = {
      id,
      numero,
      contactId: id,
      phone,
      fullName: nombre ?? phone,
      estado: 'sin_asignar' as const,
    }
    await db().insert(conversacionesStandalone).values(nueva)
    return { ...nueva, mensajes: [] }
  }

  // Si antes no teníamos el nombre real del contacto (se guardó el teléfono como
  // provisorio) y ahora llegó uno, se actualiza.
  if (nombre && existente.fullName === existente.phone) {
    await db().update(conversacionesStandalone).set({ fullName: nombre }).where(eq(conversacionesStandalone.id, id))
    existente.fullName = nombre
  }
  // No se cargan los mensajes acá a propósito — quien llama a esta función (el webhook)
  // solo necesita el `id`; usar obtenerConversacion() si hace falta el hilo completo.
  return { ...aConversacionBase(existente), mensajes: [] }
}

export async function agregarMensaje(
  conversationId: string,
  body: string,
  direction: 'inbound' | 'outbound',
  adjunto?: Adjunto,
  opts: { status?: EstadoMensaje; waId?: string } = {},
): Promise<StandaloneMensaje | null> {
  const [conv] = await db().select({ id: conversacionesStandalone.id }).from(conversacionesStandalone).where(eq(conversacionesStandalone.id, conversationId))
  if (!conv) return null

  const nuevo = {
    id: randomUUID(),
    conversacionId: conversationId,
    body,
    direction,
    adjunto: adjunto ?? null,
    status: direction === 'outbound' ? (opts.status ?? 'sent') : null,
    waId: opts.waId ?? null,
  }
  const [insertado] = await db().insert(mensajesStandalone).values(nuevo).returning()
  // Un mensaje saliente (el agente respondiendo) cuenta como "visto" hasta ahí — si no,
  // lastMessageId avanza al mensaje propio pero vistoHastaMensajeId se queda en el
  // inbound anterior, y la conversación vuelve a aparecer como "sin leer" apenas se sale
  // de ella, aunque el último mensaje sea nuestro.
  await db()
    .update(conversacionesStandalone)
    .set({ actualizadoEn: new Date(), ...(direction === 'outbound' ? { vistoHastaMensajeId: insertado.id } : {}) })
    .where(eq(conversacionesStandalone.id, conversationId))
  return aStandaloneMensaje(insertado)
}

// Cruza el `waId` que devuelve un webhook de estado de Kapso (`message.id`) contra los
// mensajes salientes guardados, para actualizar el tick de "enviado/entregado/leído"
// (ver ARCHITECTURE.md §19). Devuelve el número (canal) al que pertenece, para poder
// emitir el evento SSE con el scope correcto.
export async function actualizarEstadoMensaje(waId: string, status: EstadoMensaje): Promise<{ numero: NumeroId } | null> {
  const [actualizado] = await db()
    .update(mensajesStandalone)
    .set({ status })
    .where(eq(mensajesStandalone.waId, waId))
    .returning({ conversacionId: mensajesStandalone.conversacionId })
  if (!actualizado) return null

  const [conv] = await db().select({ numero: conversacionesStandalone.numero }).from(conversacionesStandalone).where(eq(conversacionesStandalone.id, actualizado.conversacionId))
  return conv ? { numero: conv.numero as NumeroId } : null
}

// Reacción con emoji a un mensaje — mismo criterio que actualizarEstadoMensaje: cruza
// por waId (funciona tanto para reaccionar a un mensaje saliente nuestro, como para
// cuando el CONTACTO reacciona a uno de esos mensajes desde su WhatsApp, vía webhook).
// emoji === '' saca la reacción (mismo criterio que la API de Meta/Kapso).
export async function actualizarReaccionMensaje(waId: string, emoji: string): Promise<{ numero: NumeroId } | null> {
  const [actualizado] = await db()
    .update(mensajesStandalone)
    .set({ reaccion: emoji || null })
    .where(eq(mensajesStandalone.waId, waId))
    .returning({ conversacionId: mensajesStandalone.conversacionId })
  if (!actualizado) return null

  const [conv] = await db().select({ numero: conversacionesStandalone.numero }).from(conversacionesStandalone).where(eq(conversacionesStandalone.id, actualizado.conversacionId))
  return conv ? { numero: conv.numero as NumeroId } : null
}

// "Leído" es una propiedad de la conversación, no de quién la mira (ver el comentario
// junto a la columna en src/db/schema/standalone.ts) — cualquier agente que abra la
// conversación la marca como vista para todos, sin chequeo de dueño. Devuelve el número
// para poder avisar por SSE a las demás pestañas/agentes que la estén mirando.
export async function marcarConversacionVista(id: string, mensajeId: string): Promise<{ numero: NumeroId } | null> {
  const [actualizado] = await db()
    .update(conversacionesStandalone)
    .set({ vistoHastaMensajeId: mensajeId })
    .where(eq(conversacionesStandalone.id, id))
    .returning({ numero: conversacionesStandalone.numero })
  return actualizado ? { numero: actualizado.numero as NumeroId } : null
}

// Para el indicador de "escribiendo…": Meta requiere el id del último mensaje ENTRANTE
// para poder mostrarle a ese contacto que le estamos por responder (ver ARCHITECTURE.md §19).
// Pura — opera sobre una conversación ya cargada con obtenerConversacion(), no pega contra la base.
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

export async function asignarConversacion(id: string, agente: Agente): Promise<ResultadoAsignacion> {
  const [actualizado] = await db()
    .update(conversacionesStandalone)
    .set({
      estado: 'asignada',
      asignadaAId: agente.id,
      asignadaANombre: agente.nombre,
      ultimoAgenteId: agente.id,
      ultimoAgenteNombre: agente.nombre,
      actualizadoEn: new Date(),
    })
    .where(
      and(
        eq(conversacionesStandalone.id, id),
        ne(conversacionesStandalone.estado, 'cerrada'),
        or(ne(conversacionesStandalone.estado, 'asignada'), eq(conversacionesStandalone.asignadaAId, agente.id)),
      ),
    )
    .returning()
  if (actualizado) return { ok: true }

  const [actual] = await db().select().from(conversacionesStandalone).where(eq(conversacionesStandalone.id, id))
  if (!actual) return { ok: false, motivo: 'no_existe' }
  if (actual.estado === 'cerrada') return { ok: false, motivo: 'cerrada' }
  return { ok: false, motivo: 'ya_asignada', asignadaA: aAgente(actual.asignadaAId, actual.asignadaANombre) }
}

// Solo el dueño actual puede liberar/cerrar — antes esto lo podía hacer cualquiera (sin
// chequear agenteId), lo que rompía por completo la garantía de bloqueo (§18): cualquiera
// podía sacarle a otro agente una conversación tomada, o cerrarla, sin su consentimiento.
export async function liberarConversacion(id: string, agenteId: string): Promise<boolean> {
  const [actualizado] = await db()
    .update(conversacionesStandalone)
    .set({ estado: 'sin_asignar', asignadaAId: null, asignadaANombre: null, actualizadoEn: new Date() })
    .where(and(eq(conversacionesStandalone.id, id), eq(conversacionesStandalone.estado, 'asignada'), eq(conversacionesStandalone.asignadaAId, agenteId)))
    .returning()
  return !!actualizado
}

export async function cerrarConversacion(id: string, agenteId: string): Promise<boolean> {
  const [actualizado] = await db()
    .update(conversacionesStandalone)
    .set({ estado: 'cerrada', actualizadoEn: new Date() })
    .where(and(eq(conversacionesStandalone.id, id), eq(conversacionesStandalone.estado, 'asignada'), eq(conversacionesStandalone.asignadaAId, agenteId)))
    .returning()
  return !!actualizado
}

export type ResultadoTraspaso = { ok: true } | { ok: false; motivo: 'no_existe' | 'no_sos_dueño' }

// El dueño actual le pasa la conversación directo a otro agente (queda 'asignada' todo
// el tiempo, sin pasar por 'sin_asignar' en el medio) — a diferencia de liberar, nadie
// más puede agarrarla de pasada durante el traspaso.
export async function traspasarConversacion(id: string, deAgenteId: string, destino: Agente): Promise<ResultadoTraspaso> {
  const [actualizado] = await db()
    .update(conversacionesStandalone)
    .set({
      asignadaAId: destino.id,
      asignadaANombre: destino.nombre,
      ultimoAgenteId: destino.id,
      ultimoAgenteNombre: destino.nombre,
      actualizadoEn: new Date(),
    })
    .where(and(eq(conversacionesStandalone.id, id), eq(conversacionesStandalone.estado, 'asignada'), eq(conversacionesStandalone.asignadaAId, deAgenteId)))
    .returning()
  if (actualizado) return { ok: true }

  const [actual] = await db().select({ id: conversacionesStandalone.id }).from(conversacionesStandalone).where(eq(conversacionesStandalone.id, id))
  return { ok: false, motivo: actual ? 'no_sos_dueño' : 'no_existe' }
}
