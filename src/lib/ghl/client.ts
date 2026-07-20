import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { ghlInstalls, type GhlInstall } from '@/db/schema'

const API_BASE = 'https://services.leadconnectorhq.com'

// Cada grupo de endpoints de la API de GHL exige un header "Version" propio.
const VERSION_CONVERSATIONS = '2021-04-15'
const VERSION_CONTACTS = '2021-07-28'

class GhlApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
    this.name = 'GhlApiError'
  }
}

// ── OAuth: intercambio inicial de code y refresh de tokens ────────────────

async function requestToken(params: Record<string, string>) {
  const body = new URLSearchParams({
    client_id: process.env.GHL_CLIENT_ID!,
    client_secret: process.env.GHL_CLIENT_SECRET!,
    ...params,
  })

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    throw new GhlApiError('Fallo al obtener token de GHL', res.status, await res.text())
  }

  return res.json() as Promise<{
    access_token: string
    refresh_token: string
    expires_in: number
    locationId: string
  }>
}

export async function exchangeCodeForInstall(code: string) {
  const token = await requestToken({
    grant_type: 'authorization_code',
    code,
    user_type: 'Location',
    redirect_uri: process.env.GHL_REDIRECT_URI!,
  })

  await guardarInstall(token.locationId, token.access_token, token.refresh_token, token.expires_in)
  return token.locationId
}

async function refreshInstall(install: GhlInstall) {
  const token = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: install.refreshToken,
    user_type: 'Location',
  })

  await guardarInstall(install.locationId, token.access_token, token.refresh_token, token.expires_in)
  return token.access_token
}

async function guardarInstall(locationId: string, accessToken: string, refreshToken: string, expiresInSeconds: number) {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)

  await db()
    .insert(ghlInstalls)
    .values({ locationId, accessToken, refreshToken, expiresAt })
    .onConflictDoUpdate({
      target: ghlInstalls.locationId,
      set: { accessToken, refreshToken, expiresAt, actualizadoEn: new Date() },
    })
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refrescar si faltan menos de 5 min

async function getValidAccessToken(locationId: string): Promise<string> {
  const install = await db().query.ghlInstalls.findFirst({
    where: eq(ghlInstalls.locationId, locationId),
  })
  if (!install) throw new Error(`No hay instalación de GHL guardada para la location ${locationId}`)

  const expiraPronto = install.expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS
  if (expiraPronto) return refreshInstall(install)

  return install.accessToken
}

// ── Fetch autenticado genérico ─────────────────────────────────────────────

async function ghlFetch<T>(
  locationId: string,
  path: string,
  version: string,
  init: RequestInit = {},
): Promise<T> {
  const accessToken = await getValidAccessToken(locationId)

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: version,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init.headers,
    },
  })

  if (!res.ok) {
    throw new GhlApiError(`GHL ${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status, await res.text())
  }

  return res.json() as Promise<T>
}

// ── Contacts ────────────────────────────────────────────────────────────────

export async function upsertContact(locationId: string, telefono: string, nombre?: string) {
  return ghlFetch<{ contact: { id: string } }>(locationId, '/contacts/upsert', VERSION_CONTACTS, {
    method: 'POST',
    body: JSON.stringify({ locationId, phone: telefono, name: nombre }),
  })
}

export async function crearNota(locationId: string, contactId: string, body: string) {
  return ghlFetch(locationId, `/contacts/${contactId}/notes`, VERSION_CONTACTS, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

// ── Conversations / Messages ───────────────────────────────────────────────

export async function buscarConversaciones(locationId: string, conversationProviderId: string) {
  const params = new URLSearchParams({ locationId })
  return ghlFetch<{ conversations: unknown[] }>(
    locationId,
    `/conversations/search?${params.toString()}`,
    VERSION_CONVERSATIONS,
  )
}

export async function mensajesDeConversacion(locationId: string, conversationId: string) {
  return ghlFetch<{ messages: { messages: unknown[] } }>(
    locationId,
    `/conversations/${conversationId}/messages`,
    VERSION_CONVERSATIONS,
  )
}

export async function agregarMensajeEntrante(
  locationId: string,
  params: { contactId: string; conversationProviderId: string; message: string; attachments?: string[] },
) {
  return ghlFetch<{ conversationId: string; messageId: string }>(
    locationId,
    '/conversations/messages/inbound',
    VERSION_CONVERSATIONS,
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'WhatsApp',
        conversationProviderId: params.conversationProviderId,
        contactId: params.contactId,
        message: params.message,
        direction: 'inbound',
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      }),
    },
  )
}

export async function enviarMensaje(
  locationId: string,
  params: { contactId: string; conversationProviderId: string; message: string; attachments?: string[] },
) {
  return ghlFetch<{ conversationId: string; messageId: string; status: string }>(
    locationId,
    '/conversations/messages',
    VERSION_CONVERSATIONS,
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'WhatsApp',
        conversationProviderId: params.conversationProviderId,
        contactId: params.contactId,
        message: params.message,
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      }),
    },
  )
}

export async function actualizarEstadoMensaje(
  locationId: string,
  messageId: string,
  status: 'delivered' | 'failed' | 'pending' | 'read',
) {
  return ghlFetch(locationId, `/conversations/messages/${messageId}/status`, VERSION_CONVERSATIONS, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })
}

export { GhlApiError }
