import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { numeroPorPhoneId } from '@/lib/ghl/numeros'
import { upsertContact, agregarMensajeEntrante } from '@/lib/ghl/client'
import { STANDALONE_MODE } from '@/lib/mode'
import { encontrarOCrearConversacion, agregarMensaje } from '@/lib/standalone/store'
import { webhookLimitado } from '@/lib/rateLimit'
import { emitirEvento } from '@/lib/events'
import { parsearMensajeEntrante } from '@/lib/kapso/parseWebhook'

// TODO: reemplazar por la location real una vez definido dónde vive cada instalación
// (hoy: sandbox de developer, location de test UnDaROg6tyLshlODU22O — ver ARCHITECTURE.md)
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!

export async function POST(request: NextRequest) {
  if (webhookLimitado(request, 'kapso-webhook')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const body = await request.text()
  const signature = request.headers.get('x-webhook-signature') ?? ''
  const expected = createHmac('sha256', process.env.KAPSO_APP_SECRET!).update(body).digest('hex')

  const sigOk =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
  if (!sigOk) {
    console.error('[Kapso webhook] firma inválida')
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  const event = request.headers.get('x-webhook-event') ?? ''
  if (event !== 'whatsapp.message.received') {
    return NextResponse.json({ ok: true })
  }

  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ ok: true })
  }

  // Nota: si algún día se activa el batching de Kapso, el payload cambia de forma
  // ({ batch: true, data: [...] }) — no está habilitado hoy, así que no se maneja acá.
  const entrante = parsearMensajeEntrante(payload)
  if (!entrante) {
    return NextResponse.json({ ok: true })
  }

  const numero = numeroPorPhoneId(entrante.phoneNumberId)
  if (!numero) {
    console.error('[Kapso webhook] no se pudo identificar el número (phone_number_id):', entrante.phoneNumberId)
    return NextResponse.json({ ok: true })
  }

  // Fase 2 del roadmap: Kapso real conectado, todavía sin GHL — se guarda en memoria
  // en vez de reenviar (ver ARCHITECTURE.md §14.2). Se descarta en la Fase 6.
  if (STANDALONE_MODE) {
    const conv = encontrarOCrearConversacion(numero.id, entrante.telefono, entrante.nombreContacto)
    agregarMensaje(conv.id, entrante.texto, 'inbound', entrante.adjunto)
    emitirEvento({ tipo: 'mensaje', numero: numero.id })
    return NextResponse.json({ ok: true })
  }

  try {
    const { contact } = await upsertContact(GHL_LOCATION_ID, entrante.telefono, entrante.nombreContacto)
    await agregarMensajeEntrante(GHL_LOCATION_ID, {
      contactId: contact.id,
      conversationProviderId: numero.conversationProviderId,
      message: entrante.texto,
      attachments: entrante.adjunto ? [entrante.adjunto.url] : undefined,
    })
    emitirEvento({ tipo: 'mensaje', numero: numero.id })
  } catch (err) {
    console.error(`[Kapso webhook] error relayeando mensaje de ${numero.id} a GHL:`, err)
    return NextResponse.json({ error: 'relay failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
