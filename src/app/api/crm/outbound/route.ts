import { NextRequest, NextResponse } from 'next/server'
import { verificarFirmaGhl } from '@/lib/ghl/verifyWebhook'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { enviarPorKapso } from '@/lib/kapso/client'
import { actualizarEstadoMensaje } from '@/lib/ghl/client'
import { webhookLimitado } from '@/lib/rateLimit'
import { emitirEvento } from '@/lib/events'

type OutboundPayload = {
  contactId: string
  locationId: string
  messageId: string
  type: string
  phone: string
  message: string
}

// Delivery URL de cada Conversation Provider — configurada en GHL como
// /api/crm/outbound?numero=dealers|abonados|fullapp (ver ARCHITECTURE.md §9.2). Se llama
// "crm" y no "ghl" en la ruta porque GHL rechaza cualquier Redirect/Delivery URL que
// contenga la palabra "ghl" (ver ARCHITECTURE.md).
// Único lugar del proyecto donde efectivamente se manda un mensaje a Kapso/Meta,
// sin importar si el agente respondió desde nuestro inbox o desde el nativo de GHL.
export async function POST(request: NextRequest) {
  if (webhookLimitado(request, 'ghl-outbound')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const rawBody = await request.text()
  const sigOk = verificarFirmaGhl(rawBody, request.headers.get('x-ghl-signature'))
  if (!sigOk) {
    console.error(`[GHL outbound/${numero.id}] firma inválida`)
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody) as OutboundPayload
  if (payload.type !== 'WhatsApp' && payload.type !== 'SMS') {
    // el provider solo debería recibir mensajes de WhatsApp; se ignora cualquier otra cosa
    return NextResponse.json({ ok: true })
  }

  try {
    await enviarPorKapso(numero, payload.phone, payload.message)
    await actualizarEstadoMensaje(payload.locationId, payload.messageId, 'delivered')
    emitirEvento({ tipo: 'estado', numero: numero.id })
  } catch (err) {
    console.error(`[GHL outbound/${numero.id}] error enviando por Kapso:`, err)
    await actualizarEstadoMensaje(payload.locationId, payload.messageId, 'failed').catch(() => {})
    return NextResponse.json({ error: 'send failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
