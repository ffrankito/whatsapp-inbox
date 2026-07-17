import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { numeroPorPhoneId } from '@/lib/ghl/numeros'
import { upsertContact, agregarMensajeEntrante } from '@/lib/ghl/client'
import { STANDALONE_MODE } from '@/lib/mode'
import { encontrarOCrearConversacion, agregarMensaje } from '@/lib/standalone/store'

// TODO: reemplazar por la location real una vez definido dónde vive cada instalación
// (hoy: sandbox de developer, location de test UnDaROg6tyLshlODU22O — ver ARCHITECTURE.md)
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!

export async function POST(request: NextRequest) {
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

  // NOTA: shape confirmado parcialmente contra la doc de Kapso (whatsapp_config.phone_number_id,
  // message.*). Falta validar contra un webhook real de la cuenta de Security24 antes de producción.
  const phoneNumberId: string | undefined = payload?.whatsapp_config?.phone_number_id
  const numero = phoneNumberId ? numeroPorPhoneId(phoneNumberId) : undefined

  if (!numero) {
    console.error('[Kapso webhook] no se pudo identificar el número (phone_number_id):', phoneNumberId)
    return NextResponse.json({ ok: true })
  }

  const msg = payload?.message
  const telefono: string | undefined = msg?.from ?? payload?.conversation?.contact_phone
  const texto: string | undefined = msg?.text?.body
  const nombreContacto: string | undefined =
    payload?.contact?.profile?.name ?? payload?.conversation?.contact_name ?? undefined

  if (!telefono || !texto) {
    return NextResponse.json({ ok: true })
  }

  // Fase 2 del roadmap: Kapso real conectado, todavía sin GHL — se guarda en memoria
  // en vez de reenviar (ver ARCHITECTURE.md §14.2). Se descarta en la Fase 6.
  if (STANDALONE_MODE) {
    const conv = encontrarOCrearConversacion(numero.id, telefono, nombreContacto)
    agregarMensaje(conv.id, texto, 'inbound')
    return NextResponse.json({ ok: true })
  }

  try {
    const { contact } = await upsertContact(GHL_LOCATION_ID, telefono, nombreContacto)
    await agregarMensajeEntrante(GHL_LOCATION_ID, {
      contactId: contact.id,
      conversationProviderId: numero.conversationProviderId,
      message: texto,
    })
  } catch (err) {
    console.error(`[Kapso webhook] error relayeando mensaje de ${numero.id} a GHL:`, err)
    return NextResponse.json({ error: 'relay failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
