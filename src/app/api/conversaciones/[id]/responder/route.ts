import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { enviarMensaje } from '@/lib/ghl/client'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { agregarMensajeDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone, agregarMensaje as agregarMensajeStandalone } from '@/lib/standalone/store'
import { enviarPorKapso } from '@/lib/kapso/client'

type Body = {
  contactId: string
  numero: NumeroId
  message: string
}

// El agente responde acá -> pasa por GHL (POST /conversations/messages), que a su vez
// dispara la Delivery URL del provider (/api/ghl/outbound) y ahí recién se manda por
// Kapso. Este endpoint nunca le habla a Kapso directamente (ver ARCHITECTURE.md §4.2) —
// excepto en STANDALONE_MODE (Fase 2), donde todavía no hay GHL de por medio y este es
// el único lugar que manda de verdad.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { contactId, numero: numeroId, message }: Body = await request.json()
  const numero = NUMEROS[numeroId]
  if (!contactId || !numero || !message?.trim()) {
    return NextResponse.json({ error: 'Faltan contactId, numero o message' }, { status: 400 })
  }

  if (DEMO_MODE) {
    const nuevo = agregarMensajeDemo(id, message, 'outbound')
    if (!nuevo) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    return NextResponse.json({ conversationId: id, messageId: nuevo.id, status: 'delivered' })
  }

  if (STANDALONE_MODE) {
    const conv = obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    try {
      await enviarPorKapso(numero, conv.phone, message)
    } catch (err) {
      console.error(`[POST /api/conversaciones/${id}/responder] error enviando por Kapso:`, err)
      return NextResponse.json({ error: 'No se pudo enviar el mensaje' }, { status: 502 })
    }
    const nuevo = agregarMensajeStandalone(id, message, 'outbound')
    return NextResponse.json({ conversationId: id, messageId: nuevo?.id, status: 'delivered' })
  }

  const sesion = await sesionActual()
  const locationId = locationIdDeSesion(sesion)

  try {
    const data = await enviarMensaje(locationId, {
      contactId,
      conversationProviderId: numero.conversationProviderId,
      message,
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error(`[POST /api/conversaciones/${id}/responder] error:`, err)
    return NextResponse.json({ error: 'No se pudo enviar el mensaje' }, { status: 502 })
  }
}
