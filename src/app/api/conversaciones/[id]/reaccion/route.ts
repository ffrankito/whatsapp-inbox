import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS } from '@/lib/ghl/numeros'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { obtenerConversacion as obtenerDemo, puedeEscribirDemo, reaccionarMensajeDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone, puedeEscribir, actualizarReaccionMensaje } from '@/lib/standalone/store'
import { enviarReaccionPorKapso } from '@/lib/kapso/client'
import { emitirEvento } from '@/lib/events'

// Reaccionar con un emoji a un mensaje del hilo — mismo criterio de dueño que
// responder/mandar adjuntos (ver ARCHITECTURE.md §18): hace falta tener la
// conversación tomada. emoji: '' saca una reacción ya puesta (toggle desde el frontend).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-reaccion')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const { mensajeId, emoji } = await request.json()
  if (!mensajeId || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'Faltan mensajeId o emoji' }, { status: 400 })
  }

  if (DEMO_MODE) {
    const conv = obtenerDemo(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!puedeEscribirDemo(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }
    const ok = reaccionarMensajeDemo(id, mensajeId, emoji)
    if (!ok) return NextResponse.json({ error: 'No existe ese mensaje' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  if (STANDALONE_MODE) {
    const conv = await obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!puedeEscribir(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }

    const mensaje = conv.mensajes.find((m) => m.id === mensajeId)
    if (!mensaje?.waId) {
      return NextResponse.json({ error: 'Ese mensaje no se puede reaccionar todavía' }, { status: 400 })
    }

    const numero = NUMEROS[conv.numero]
    try {
      await enviarReaccionPorKapso(numero, conv.phone, mensaje.waId, emoji)
    } catch (err) {
      console.error(`[POST /api/conversaciones/${id}/reaccion] error enviando por Kapso:`, err)
      return NextResponse.json({ error: 'No se pudo mandar la reacción' }, { status: 502 })
    }

    const resultado = await actualizarReaccionMensaje(mensaje.waId, emoji)
    if (resultado) emitirEvento({ tipo: 'mensaje', numero: resultado.numero })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Reaccionar no soportado todavía en este modo' }, { status: 501 })
}
