import type { NumeroWhatsapp } from '@/lib/ghl/numeros'
import type { TipoAdjunto } from '@/lib/mensaje'

const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0'

export async function enviarPorKapso(numero: NumeroWhatsapp, telefono: string, texto: string) {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: texto },
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} -> ${res.status}: ${await res.text()}`)
  }

  return res.json() as Promise<{ messages?: { id: string }[] }>
}

/**
 * Sube un archivo a Kapso para poder mandarlo por WhatsApp (confirmado contra el SDK
 * oficial de Kapso, github.com/gokapso/whatsapp-cloud-api-js — POST {phoneNumberId}/media,
 * multipart). Devuelve el media id que después se usa para mandar el mensaje.
 */
export async function subirMediaAKapso(numero: NumeroWhatsapp, archivo: Blob, nombre: string, mimeType: string): Promise<string> {
  const form = new FormData()
  form.append('file', archivo, nombre)
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimeType)

  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/media`, {
    method: 'POST',
    headers: { 'X-API-Key': numero.kapsoApiKey },
    body: form,
  })

  if (!res.ok) {
    throw new Error(`Kapso media upload ${numero.id} -> ${res.status}: ${await res.text()}`)
  }

  const data = await res.json()
  const mediaId: string | undefined = data?.id
  if (!mediaId) throw new Error(`Kapso media upload ${numero.id}: sin id en la respuesta`)
  return mediaId
}

export async function enviarMediaPorKapso(
  numero: NumeroWhatsapp,
  telefono: string,
  mediaId: string,
  tipo: TipoAdjunto,
  opts: { nombre?: string; caption?: string } = {},
) {
  const mediaBody: Record<string, unknown> = { id: mediaId }
  if (opts.caption) mediaBody.caption = opts.caption
  if (tipo === 'document' && opts.nombre) mediaBody.filename = opts.nombre

  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: tipo,
      [tipo]: mediaBody,
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (media) -> ${res.status}: ${await res.text()}`)
  }

  return res.json() as Promise<{ messages?: { id: string }[] }>
}

/**
 * Manda el indicador de "escribiendo…" al contacto (se ve en su WhatsApp, no en nuestro
 * inbox — WhatsApp Business no expone al negocio cuándo el CLIENTE está escribiendo, así
 * que esto solo funciona en un sentido: agente -> cliente). Requiere el id del último
 * mensaje ENTRANTE de ese contacto. Marca ese mensaje como leído de paso (mismo pedido
 * que hace Meta). Confirmado contra Huellas de Paz — ver ARCHITECTURE.md §19.
 */
export async function enviarIndicadorEscribiendo(numero: NumeroWhatsapp, messageId: string) {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (typing) -> ${res.status}: ${await res.text()}`)
  }
}

/**
 * Marca un mensaje entrante como leído (el doble tilde azul del lado del cliente), SIN
 * el indicador de "escribiendo…" — para cuando el agente simplemente abre la
 * conversación, no cuando está por responder (eso es `enviarIndicadorEscribiendo`).
 */
export async function marcarLeido(numero: NumeroWhatsapp, messageId: string) {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (marcar leído) -> ${res.status}: ${await res.text()}`)
  }
}

/**
 * Fallback para cuando no tenemos guardado el waId del último mensaje entrante de un
 * contacto (por ejemplo, conversaciones que ya tenían mensajes viejos antes de que se
 * empezara a guardar el waId) — le pregunta directo a Kapso por los últimos mensajes
 * entrantes de este número y busca el que coincida con el teléfono del contacto.
 */
export async function buscarUltimoMensajeEntranteEnKapso(numero: NumeroWhatsapp, telefono: string): Promise<string | undefined> {
  const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const url = `${KAPSO_BASE}/${numero.phoneNumberId}/messages?direction=inbound&limit=10&since=${encodeURIComponent(desde)}`

  const res = await fetch(url, { headers: { 'X-API-Key': numero.kapsoApiKey } })
  if (!res.ok) return undefined

  const { data } = (await res.json()) as { data?: { id: string; from?: string; kapso?: { phone_number?: string } }[] }
  const normalizado = telefono.replace(/\D/g, '').slice(-10)
  const match = data?.find((m) => {
    const desdeNumero = (m.from ?? m.kapso?.phone_number ?? '').replace(/\D/g, '')
    return desdeNumero.endsWith(normalizado)
  })
  return match?.id
}
