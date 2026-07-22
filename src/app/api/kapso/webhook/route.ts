import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { numeroPorPhoneId } from '@/lib/ghl/numeros'
import { upsertContact, agregarMensajeEntrante } from '@/lib/ghl/client'
import { STANDALONE_MODE } from '@/lib/mode'
import { encontrarOCrearConversacion, agregarMensaje, actualizarEstadoMensaje, actualizarReaccionMensaje } from '@/lib/standalone/store'
import { webhookLimitado } from '@/lib/rateLimit'
import { emitirEvento } from '@/lib/events'
import { parsearMensajeEntrante, parsearReaccionEntrante } from '@/lib/kapso/parseWebhook'
import { descargarComoDataUrl } from '@/lib/kapso/client'
import type { Adjunto, EstadoMensaje } from '@/lib/mensaje'

// Reemplaza el link externo de Kapso por el archivo bajado y guardado como data: URL en
// nuestra propia base — así el archivo sigue disponible para siempre en el historial,
// sin depender de cuánto dure el link de Kapso (no hay confirmación de eso, ver
// descargarComoDataUrl). Si falla la descarga, se sigue usando el link original en vez
// de perder el adjunto por completo.
async function conAdjuntoPersistido(adjunto: Adjunto | undefined): Promise<Adjunto | undefined> {
  if (!adjunto) return adjunto
  const dataUrl = await descargarComoDataUrl(adjunto.url, adjunto.nombre)
  return dataUrl ? { ...adjunto, url: dataUrl } : adjunto
}

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

  // Actualizaciones de estado de un mensaje que MANDAMOS nosotros (tick de enviado/
  // entregado/leído) — confirmado contra Huellas de Paz: Kapso manda estos eventos por
  // separado del mensaje entrante, con el id en `message.id` y el estado en
  // `message.kapso.status` (o se deriva del nombre del evento si no viene explícito).
  // Ver ARCHITECTURE.md §19.
  const EVENTOS_ESTADO = [
    'whatsapp.message.status',
    'whatsapp.message.sent',
    'whatsapp.message.delivered',
    'whatsapp.message.read',
    'whatsapp.message.failed',
  ]
  if (EVENTOS_ESTADO.includes(event)) {
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch {
      return NextResponse.json({ ok: true })
    }
    if (STANDALONE_MODE) {
      const messageId: string | undefined = payload?.message?.id ?? payload?.message_id
      const rawStatus: string | undefined = payload?.message?.kapso?.status ?? event.replace('whatsapp.message.', '')
      const status: EstadoMensaje =
        rawStatus === 'delivered' ? 'delivered' :
        rawStatus === 'read' ? 'read' :
        rawStatus === 'failed' ? 'failed' :
        'sent'
      const resultado = messageId ? await actualizarEstadoMensaje(messageId, status) : null
      if (resultado) {
        emitirEvento({ tipo: 'mensaje', numero: resultado.numero })
      } else if (event === 'whatsapp.message.sent' && payload?.message?.kapso?.direction === 'outbound') {
        // No es un mensaje que hayamos mandado nosotros (si lo fuera, actualizarEstadoMensaje
        // lo habría encontrado) — el número está en coexistencia, así que esto es un
        // mensaje que el equipo mandó directo desde la app de WhatsApp Business del
        // celular. Se agrega igual al historial (marcado como "[Celular]"), si no el
        // hilo queda incompleto para quien lo vea desde acá.
        const saliente = parsearMensajeEntrante(payload)
        if (saliente) {
          const numero = numeroPorPhoneId(saliente.phoneNumberId)
          if (!numero) {
            console.error('[Kapso webhook] mensaje del celular: no se pudo identificar el número (phone_number_id):', saliente.phoneNumberId)
          } else {
            const conv = await encontrarOCrearConversacion(numero.id, saliente.telefono, saliente.nombreContacto)
            const adjuntoPersistido = await conAdjuntoPersistido(saliente.adjunto)
            await agregarMensaje(conv.id, `[Celular] ${saliente.texto}`, 'outbound', adjuntoPersistido, { status: 'sent', waId: saliente.waId })
            emitirEvento({ tipo: 'mensaje', numero: numero.id })
          }
        }
      }
    }
    // TODO (Fase 6): en modo GHL real todavía no se refleja el estado de entrega ahí.
    return NextResponse.json({ ok: true })
  }

  if (event !== 'whatsapp.message.received') {
    return NextResponse.json({ ok: true })
  }

  let payload: any
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ ok: true })
  }

  // El contacto reaccionó con un emoji a uno de NUESTROS mensajes salientes (no es un
  // mensaje nuevo en el hilo, es una actualización de uno existente) — se maneja antes
  // que parsearMensajeEntrante porque esa función no sabe de reacciones (ver BACKLOG.md,
  // reacciones con emoji).
  const reaccion = parsearReaccionEntrante(payload)
  if (reaccion) {
    if (STANDALONE_MODE) {
      const resultado = await actualizarReaccionMensaje(reaccion.messageId, reaccion.emoji)
      if (resultado) {
        emitirEvento({ tipo: 'mensaje', numero: resultado.numero })
      }
    }
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
    const conv = await encontrarOCrearConversacion(numero.id, entrante.telefono, entrante.nombreContacto)
    const adjuntoPersistido = await conAdjuntoPersistido(entrante.adjunto)
    await agregarMensaje(conv.id, entrante.texto, 'inbound', adjuntoPersistido, { waId: entrante.waId })
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
