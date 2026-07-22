import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { mensajesDeConversacion } from '@/lib/ghl/client'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { agenteActual } from '@/lib/agente'
import { obtenerConversacion as obtenerDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone } from '@/lib/standalone/store'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Ver conversaciones no requiere ser el dueño (eso es solo para escribir, ver
  // ARCHITECTURE.md §18), pero sí requiere ser un agente identificado — si no, es un
  // IDOR: el id se deriva de forma predecible de número+teléfono, cualquiera que lo
  // arme podía leer el hilo entero sin loguearse (ver BACKLOG.md #14).
  if (DEMO_MODE || STANDALONE_MODE) {
    const agente = await agenteActual(request)
    if (!agente) {
      return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
    }
  }

  if (DEMO_MODE) {
    const conv = obtenerDemo(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    return NextResponse.json({ messages: { messages: conv.mensajes }, estado: conv.estado, asignadaA: conv.asignadaA })
  }

  if (STANDALONE_MODE) {
    const conv = await obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    return NextResponse.json({ messages: { messages: conv.mensajes }, estado: conv.estado, asignadaA: conv.asignadaA })
  }

  const sesion = await sesionActual()
  const locationId = locationIdDeSesion(sesion)

  try {
    const data = await mensajesDeConversacion(locationId, id)
    return NextResponse.json(data)
  } catch (err) {
    console.error(`[GET /api/conversaciones/${id}] error consultando GHL:`, err)
    return NextResponse.json({ error: 'No se pudo obtener la conversación' }, { status: 502 })
  }
}
