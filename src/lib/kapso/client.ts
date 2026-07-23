import type { NumeroWhatsapp } from '@/lib/ghl/numeros'
import type { TipoAdjunto } from '@/lib/mensaje'
import { inferirContentType } from '@/lib/mime'
import { subirArchivo } from '@/lib/storage'

const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0'
// Igual que TAMANO_MAXIMO en la ruta de adjuntos salientes — si el archivo entrante es
// más grande que esto, se deja el link externo de Kapso en vez de bajarlo (evita
// hinchar la base con archivos gigantes; no se sabe si esos links vencen, pero es mejor
// que nada en el caso raro de que pase).
const TAMANO_MAXIMO_DESCARGA = 16 * 1024 * 1024

/**
 * Baja un archivo entrante desde la URL propia de Kapso (media_url) y lo sube a nuestro
 * storage propio (MinIO, ver src/lib/storage.ts) — así el archivo queda guardado de
 * verdad ni bien llega, en vez de depender de que el link de Kapso siga sirviendo el
 * archivo indefinidamente (no hay confirmación de cuánto dura). Devuelve la referencia
 * interna (no una URL real) para guardar en `adjunto.url`, o null si falla la descarga o
 * el archivo es demasiado grande — el caller debe hacer fallback al link original de
 * Kapso en ese caso, no perder el mensaje entero.
 *
 * `nombreArchivo` es opcional, se usa solo para inferir el Content-Type por extensión si
 * Kapso no manda uno específico (ver src/lib/mime.ts) — sin esto, un PDF con Content-Type
 * genérico quedaría guardado como "application/octet-stream" y el navegador lo trataría
 * como binario desconocido (fuerza descarga) en vez de mostrarlo inline.
 */
export async function persistirAdjuntoEntrante(url: string, nombreArchivo?: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`[persistirAdjuntoEntrante] Kapso devolvió ${res.status} al bajar el archivo, se usa el link original:`, url)
      return null
    }

    const declarado = Number(res.headers.get('content-length') ?? 0)
    if (declarado > TAMANO_MAXIMO_DESCARGA) {
      console.error(`[persistirAdjuntoEntrante] archivo demasiado grande (${declarado} bytes, máximo ${TAMANO_MAXIMO_DESCARGA}), se usa el link original:`, url)
      return null
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > TAMANO_MAXIMO_DESCARGA) {
      console.error(`[persistirAdjuntoEntrante] archivo demasiado grande (${buffer.byteLength} bytes, máximo ${TAMANO_MAXIMO_DESCARGA}), se usa el link original:`, url)
      return null
    }

    const mime = inferirContentType(nombreArchivo, res.headers.get('content-type')?.split(';')[0]?.trim())
    return await subirArchivo(buffer, mime, nombreArchivo)
  } catch (err) {
    console.error('[persistirAdjuntoEntrante] error bajando/subiendo el archivo:', err)
    return null
  }
}

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
 * Manda un mensaje de plantilla (HSM) — el único tipo de mensaje que WhatsApp permite
 * para arrancar una conversación nueva o reabrir una fuera de la ventana de 24hs (ver
 * docs/BACKLOG.md #6). A diferencia de enviarPorKapso, esto solo funciona con una
 * plantilla ya aprobada por Meta de antemano, no con texto libre.
 *
 * `parametros` son named params (`parameter_format: NAMED` al crear la plantilla en
 * Meta) — confirmado contra la doc de Kapso (docs.kapso.ai, sección "Simple text"):
 * cada uno va como `{ type: 'text', parameter_name, text }`, no posicional `{{1}}`.
 */
export async function enviarPlantillaPorKapso(
  numero: NumeroWhatsapp,
  telefono: string,
  nombrePlantilla: string,
  idioma: string,
  parametros: Record<string, string> = {},
) {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: nombrePlantilla,
        language: { code: idioma },
        components:
          Object.keys(parametros).length > 0
            ? [
                {
                  type: 'body',
                  parameters: Object.entries(parametros).map(([parameter_name, text]) => ({
                    type: 'text',
                    parameter_name,
                    text,
                  })),
                },
              ]
            : undefined,
      },
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (template) -> ${res.status}: ${await res.text()}`)
  }

  return res.json() as Promise<{ messages?: { id: string }[] }>
}

/**
 * Reacciona con un emoji a un mensaje (nuestro o del contacto) — mismo formato estándar
 * de Meta Cloud API para mensajes de tipo "reaction" (a diferencia de Contacts, esto NO
 * es una extensión propia de Kapso, así que el shape es el mismo que usa Meta de verdad:
 * `type: 'reaction', reaction: { message_id, emoji }`). Mandar `emoji: ''` saca una
 * reacción ya puesta (mismo criterio que la API de Meta).
 */
export async function enviarReaccionPorKapso(numero: NumeroWhatsapp, telefono: string, messageId: string, emoji: string) {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (reaction) -> ${res.status}: ${await res.text()}`)
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

export type ContactoKapso = {
  id: string
  waId: string
  // profileName: el nombre que el CONTACTO puso en su propio WhatsApp — de solo
  // lectura, no se puede editar (lo confirma la doc de update-contact: ese endpoint
  // solo deja tocar display_name/metadata, nunca profile_name).
  profileName?: string
  // displayName: apodo propio de Kapso, editable — lo que en la práctica se usa como
  // "el nombre guardado del contacto" en la agenda.
  displayName?: string
  customerId?: string
}

const CONTACTS_LIST_LIMITE_MAXIMO = 100 // confirmado en la doc REST (default 20, max 100)

/**
 * Agenda de contactos de Kapso — "keeps a directory of contacts observed in
 * conversations" (docs.kapso.ai, sección Contacts), se arma sola a partir del
 * historial, no hace falta cargarla a mano. Separada por phoneNumberId, igual que
 * el resto de este cliente.
 *
 * Confirmado contra la doc REST oficial (docs.kapso.ai/api/meta/whatsapp/contacts/
 * list-contacts) — GET {KAPSO_BASE}/{phoneNumberId}/contacts, paginación por cursor
 * con los parámetros `after`/`before` (paging.cursors.after en la respuesta).
 */
type ContactoKapsoRaw = {
  id: string
  wa_id?: string
  profile_name?: string
  display_name?: string
  customer_id?: string
}
type PaginaContactosKapso = { data?: ContactoKapsoRaw[]; paging?: { cursors?: { after?: string } } }

// Tope defensivo de páginas — corta un loop infinito si la API alguna vez devolviera un
// cursor que no avanza de verdad.
const MAX_PAGINAS_CONTACTOS = 20

/**
 * Trae TODOS los contactos del número, no solo la primera página — antes se pedía una
 * sola tanda y listo, así que un número con más contactos que ese límite dejaba afuera
 * a cualquiera más allá de la primera página (bug real: un contacto con conversación
 * activa no aparecía en la agenda). Sigue pidiendo la próxima página mientras la
 * respuesta traiga `paging.cursors.after`.
 */
export async function listarContactosKapso(
  numero: NumeroWhatsapp,
  opts: { search?: string; limit?: number } = {},
): Promise<ContactoKapso[]> {
  const limite = Math.min(opts.limit ?? CONTACTS_LIST_LIMITE_MAXIMO, CONTACTS_LIST_LIMITE_MAXIMO)
  let url = `${KAPSO_BASE}/${numero.phoneNumberId}/contacts?${new URLSearchParams({ limit: String(limite) })}`
  const crudos: ContactoKapsoRaw[] = []

  for (let pagina = 0; pagina < MAX_PAGINAS_CONTACTOS && url; pagina++) {
    const res = await fetch(url, { headers: { 'X-API-Key': numero.kapsoApiKey } })
    if (!res.ok) {
      throw new Error(`Kapso ${numero.id} (contacts) -> ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as PaginaContactosKapso
    crudos.push(...(data.data ?? []))

    const cursor = data.paging?.cursors?.after
    url = cursor ? `${KAPSO_BASE}/${numero.phoneNumberId}/contacts?${new URLSearchParams({ limit: String(limite), after: cursor })}` : ''
  }

  const contactos = crudos.map((c) => ({
    id: c.id,
    waId: c.wa_id ?? '',
    profileName: c.profile_name,
    displayName: c.display_name,
    customerId: c.customer_id,
  }))

  // Búsqueda por nombre/teléfono en memoria — no está confirmado si la API soporta
  // filtro server-side por texto libre (sí por waId puntual).
  if (!opts.search) return contactos
  const q = opts.search.trim().toLowerCase()
  if (!q) return contactos
  return contactos.filter(
    (c) => c.displayName?.toLowerCase().includes(q) || c.profileName?.toLowerCase().includes(q) || c.waId.toLowerCase().includes(q),
  )
}

/**
 * Actualiza el "apodo" (display_name) de un contacto — profile_name (el nombre que el
 * contacto puso en su propio WhatsApp) no se puede tocar, solo lo confirma este
 * endpoint. Confirmado contra la doc REST oficial (docs.kapso.ai/api/platform/v1/
 * contacts/update-contact): API y path DISTINTOS al resto de este archivo — vive bajo
 * /platform/v1, no /meta/whatsapp/v24.0, y el identificador va directo en la URL (el
 * waId, sin phoneNumberId en el path).
 */
export async function actualizarContactoKapso(numero: NumeroWhatsapp, waId: string, displayName: string): Promise<void> {
  const res = await fetch(`https://api.kapso.ai/platform/v1/whatsapp/contacts/${encodeURIComponent(waId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({ contact: { display_name: displayName } }),
  })

  if (!res.ok) {
    throw new Error(`Kapso ${numero.id} (update contact) -> ${res.status}: ${await res.text()}`)
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
