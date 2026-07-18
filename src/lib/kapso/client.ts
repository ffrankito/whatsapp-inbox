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
