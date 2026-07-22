import type { NumeroWhatsapp } from '@/lib/ghl/numeros'
import type { TipoAdjunto } from '@/lib/mensaje'

const KAPSO_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0'
// Igual que TAMANO_MAXIMO en la ruta de adjuntos salientes — si el archivo entrante es
// más grande que esto, se deja el link externo de Kapso en vez de bajarlo (evita
// hinchar la base con archivos gigantes; no se sabe si esos links vencen, pero es mejor
// que nada en el caso raro de que pase).
const TAMANO_MAXIMO_DESCARGA = 16 * 1024 * 1024

/**
 * Baja un archivo entrante desde la URL propia de Kapso (media_url) y lo convierte a un
 * data: URL en base64 — mismo criterio que ya usa comoDataUrl() para lo saliente (ver
 * src/app/api/conversaciones/[id]/adjunto/route.ts). Se hace para que el archivo quede
 * guardado de verdad en nuestra base ni bien llega, en vez de depender de que el link de
 * Kapso siga sirviendo el archivo indefinidamente (no hay confirmación de cuánto dura).
 * Devuelve null si falla o el archivo es demasiado grande — el caller debe hacer
 * fallback al link original de Kapso en ese caso, no perder el mensaje entero.
 */
export async function descargarComoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null

    const declarado = Number(res.headers.get('content-length') ?? 0)
    if (declarado > TAMANO_MAXIMO_DESCARGA) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > TAMANO_MAXIMO_DESCARGA) return null

    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
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
  profileName?: string
  customerId?: string
}

/**
 * Agenda de contactos de Kapso — "keeps a directory of contacts observed in
 * conversations" (docs.kapso.ai, sección Contacts), se arma sola a partir del
 * historial, no hace falta cargarla a mano. Separada por phoneNumberId, igual que
 * el resto de este cliente.
 *
 * OJO: el path REST de abajo (`/{phoneNumberId}/contacts`) sigue el mismo patrón que
 * el resto de este archivo (mismo estilo que Meta Graph API), pero TODAVÍA NO SE
 * CONFIRMÓ contra tráfico real — la doc de Kapso solo publica el SDK de TypeScript
 * (`client.contacts.list(...)`), no el path HTTP crudo. Las credenciales de test
 * locales estaban vencidas al momento de escribir esto (devolvían 404 "WhatsApp
 * configuration not found" incluso contra /messages, que sí funciona en producción).
 * Confirmar/corregir este path contra las credenciales reales de Railway antes de
 * darlo por bueno del todo (mismo criterio que el resto de este archivo, ver
 * comentarios de parseWebhook.ts sobre "confirmado contra tráfico real").
 */
type ContactoKapsoRaw = { id: string; wa_id?: string; waId?: string; profile_name?: string; profileName?: string; customer_id?: string }
type PaginaContactosKapso = { data?: ContactoKapsoRaw[]; paging?: { next?: string; cursors?: { after?: string } } }

// Tope defensivo de páginas — la doc de Kapso no confirma el shape exacto de paginación
// (se asume el estándar de Meta Graph API: paging.next / paging.cursors.after), así que
// esto corta un loop infinito si la respuesta viniera con una forma inesperada que
// nunca deje de "tener siguiente página".
const MAX_PAGINAS_CONTACTOS = 20

/**
 * Trae TODOS los contactos del número, no solo la primera página — antes se pedía una
 * sola tanda de 50 y listo, así que un número con más de 50 contactos dejaba afuera a
 * cualquiera que estuviera más allá de esa primera página (bug real: un contacto con
 * conversación activa no aparecía en la agenda). Sigue paginando mientras la respuesta
 * traiga `paging.next` (Kapso/Meta ya arma esa URL completa, se usa tal cual) o
 * `paging.cursors.after` (se arma la siguiente request con ese cursor a mano).
 */
export async function listarContactosKapso(
  numero: NumeroWhatsapp,
  opts: { search?: string; limit?: number } = {},
): Promise<ContactoKapso[]> {
  // Confirmado contra tráfico real: el path /{phoneNumberId}/contacts existe (bien), pero
  // Kapso rechaza limit=200 con 400 "Invalid limit parameter" — se baja a 50 (mismo valor
  // del ejemplo de la doc oficial del SDK) hasta confirmar el máximo real permitido.
  const limite = Math.min(opts.limit ?? 50, 50)
  let url = `${KAPSO_BASE}/${numero.phoneNumberId}/contacts?${new URLSearchParams({ limit: String(limite) })}`
  const crudos: ContactoKapsoRaw[] = []

  for (let pagina = 0; pagina < MAX_PAGINAS_CONTACTOS && url; pagina++) {
    const res = await fetch(url, { headers: { 'X-API-Key': numero.kapsoApiKey } })
    if (!res.ok) {
      throw new Error(`Kapso ${numero.id} (contacts) -> ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as PaginaContactosKapso
    crudos.push(...(data.data ?? []))

    // Confirmado contra tráfico real (log de error): `paging.next` NO es una URL lista
    // para pedir (a diferencia de Meta Graph API) — es directamente el cursor en base64
    // (keyset: fecha + id), hay que armar nosotros la siguiente URL con `after=`.
    const cursor = data.paging?.next ?? data.paging?.cursors?.after
    if (cursor) {
      url = `${KAPSO_BASE}/${numero.phoneNumberId}/contacts?${new URLSearchParams({ limit: String(limite), after: cursor })}`
    } else {
      // Sin cursor — si esta página vino llena (=== limite) pero no hay forma de pedir
      // la siguiente, se corta acá aunque falten contactos. Se loguea el shape real de
      // `paging` para poder ajustar esto sin adivinar de nuevo.
      if (crudos.length === limite * (pagina + 1)) {
        console.error(`[listarContactosKapso] posible paginación no reconocida para ${numero.id} — paging recibido:`, JSON.stringify(data.paging))
      }
      url = ''
    }
  }

  const contactos = crudos.map((c) => ({
    id: c.id,
    waId: c.wa_id ?? c.waId ?? '',
    profileName: c.profile_name ?? c.profileName,
    customerId: c.customer_id,
  }))

  // Búsqueda por nombre/teléfono en memoria — no está confirmado si la API soporta
  // filtro server-side por texto libre (sí por waId puntual, según la doc del SDK).
  if (!opts.search) return contactos
  const q = opts.search.trim().toLowerCase()
  if (!q) return contactos
  return contactos.filter(
    (c) => c.profileName?.toLowerCase().includes(q) || c.waId.toLowerCase().includes(q),
  )
}

export async function actualizarContactoKapso(numero: NumeroWhatsapp, waId: string, profileName: string): Promise<void> {
  const res = await fetch(`${KAPSO_BASE}/${numero.phoneNumberId}/contacts/${encodeURIComponent(waId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': numero.kapsoApiKey,
    },
    body: JSON.stringify({ profile_name: profileName }),
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
