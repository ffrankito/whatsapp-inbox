import type { Adjunto, TipoAdjunto } from '@/lib/mensaje'

export type MensajeKapsoEntrante = {
  phoneNumberId: string
  telefono: string
  texto: string
  nombreContacto?: string
  adjunto?: Adjunto
  waId?: string
}

const TIPOS_MEDIA: TipoAdjunto[] = ['image', 'audio', 'document', 'video', 'sticker']

/**
 * Parsea un payload de "whatsapp.message.received" (Kapso-kind webhook).
 *
 * Confirmado contra dos fuentes reales (no es una suposición):
 * 1. El inbox de WhatsApp de Huellas de Paz (mismo proveedor, en producción).
 * 2. El código fuente del SDK/reference-app oficial de Kapso
 *    (github.com/gokapso/whatsapp-cloud-inbox y whatsapp-cloud-api-js).
 *
 * Puntos clave que originalmente se habían adivinado mal:
 * - `phone_number_id` va en la RAÍZ del payload (o en `conversation.phone_number_id`),
 *   nunca dentro de un objeto `whatsapp_config` (eso no existe en la doc de Kapso).
 * - El teléfono del contacto viene primero en `conversation.phone_number` (con "+"
 *   adelante, hay que sacarlo), con `message.from` como fallback legado de Meta.
 * - El nombre del contacto viene primero en `conversation.kapso.contact_name`.
 */
export function parsearMensajeEntrante(payload: any): MensajeKapsoEntrante | null {
  const message = payload?.message
  const conversation = payload?.conversation
  if (!message) return null

  const phoneNumberId: string | undefined = payload?.phone_number_id ?? conversation?.phone_number_id
  if (!phoneNumberId) return null

  const telefonoRaw: string | undefined = conversation?.phone_number ?? message?.from
  const telefono = telefonoRaw?.replace(/^\+/, '')
  if (!telefono) return null

  const nombreContacto: string | undefined =
    conversation?.kapso?.contact_name ?? conversation?.contact_name ?? payload?.contact?.profile?.name ?? undefined

  // Id del mensaje en Meta/Kapso (`message.id`, confirmado contra Huellas de Paz) — se
  // guarda para poder mandar el indicador de "escribiendo…" más adelante (necesita el id
  // del último mensaje entrante, ver ARCHITECTURE.md §19). Los webhooks de estado en
  // cambio no lo necesitan acá porque solo actualizan mensajes salientes.
  const waId: string | undefined = message?.id

  const tipo: string | undefined = message?.type

  if (tipo === 'text') {
    const texto = message?.text?.body?.trim()
    if (!texto) return null
    return { phoneNumberId, telefono, texto, nombreContacto, waId }
  }

  if (tipo && TIPOS_MEDIA.includes(tipo as TipoAdjunto)) {
    // Kapso espeja el archivo a una URL propia poco después de recibirlo
    // (`message.kapso.media_url` / `message.kapso.media_data.url`). Si todavía no
    // llegó a espejarse, no reintentamos descarga por mediaId — se documenta como
    // limitación conocida (ver ARCHITECTURE.md).
    const mediaUrl: string | undefined = message?.kapso?.media_url ?? message?.kapso?.media_data?.url
    const nombreArchivo: string | undefined = message?.kapso?.media_data?.filename
    const caption: string | undefined = message?.[tipo]?.caption

    if (!mediaUrl) {
      return {
        phoneNumberId,
        telefono,
        texto: caption || `[${etiquetaTipo(tipo)} — todavía procesándose]`,
        nombreContacto,
        waId,
      }
    }

    return {
      phoneNumberId,
      telefono,
      texto: caption || `[${etiquetaTipo(tipo)}]`,
      nombreContacto,
      adjunto: { url: mediaUrl, tipo: tipo as TipoAdjunto, nombre: nombreArchivo },
      waId,
    }
  }

  // Otros tipos (location, reaction, interactive, etc.) — no soportados todavía.
  return null
}

export type ReaccionKapsoEntrante = {
  phoneNumberId: string
  messageId: string
  emoji: string
}

/**
 * Parsea una reacción que el CONTACTO le puso a uno de NUESTROS mensajes salientes,
 * desde su WhatsApp — llega dentro del mismo evento `whatsapp.message.received`, como
 * un mensaje más con `message.type === 'reaction'` (formato estándar de Meta, no una
 * extensión de Kapso — ver enviarReaccionPorKapso). `message.reaction.message_id` es el
 * waId del mensaje NUESTRO al que reaccionaron, no un mensaje nuevo en el hilo.
 *
 * NO CONFIRMADO todavía contra un webhook real (a diferencia del resto de este archivo) —
 * Kapso espeja el formato de Meta para el resto de tipos de mensaje, así que se asume el
 * mismo shape acá, pero conviene probarlo contra tráfico real antes de darlo por bueno.
 */
export function parsearReaccionEntrante(payload: any): ReaccionKapsoEntrante | null {
  const message = payload?.message
  const conversation = payload?.conversation
  if (!message || message.type !== 'reaction') return null

  const phoneNumberId: string | undefined = payload?.phone_number_id ?? conversation?.phone_number_id
  const messageId: string | undefined = message?.reaction?.message_id
  if (!phoneNumberId || !messageId) return null

  const emoji: string = message?.reaction?.emoji ?? ''
  return { phoneNumberId, messageId, emoji }
}

function etiquetaTipo(tipo: string): string {
  switch (tipo) {
    case 'image': return 'Imagen'
    case 'audio': return 'Audio'
    case 'document': return 'Documento'
    case 'video': return 'Video'
    case 'sticker': return 'Sticker'
    default: return tipo
  }
}
