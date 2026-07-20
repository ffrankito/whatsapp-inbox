import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { crearNota } from '@/lib/ghl/client'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { agregarNotaDemo, obtenerConversacion as obtenerDemo, puedeEscribirDemo } from '@/lib/demo/store'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { obtenerConversacion as obtenerStandalone, puedeEscribir } from '@/lib/standalone/store'

type Body = { contactId: string; body: string }

// Proxy directo a GHL — la nota queda guardada a nivel de contacto en GHL,
// sin tabla propia (ver ARCHITECTURE.md §6 "Notas / auditoría").
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-notas')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const { contactId, body }: Body = await request.json()
  if (!contactId || !body?.trim()) {
    return NextResponse.json({ error: 'Faltan contactId o body' }, { status: 400 })
  }

  const agente = await agenteActual(request)

  if (DEMO_MODE) {
    const conv = obtenerDemo(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribirDemo(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }
    agregarNotaDemo(contactId, body)
    return NextResponse.json({ ok: true })
  }

  if (STANDALONE_MODE) {
    const conv = await obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribir(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }
    console.log(`[standalone] nota para ${contactId}: ${body}`)
    return NextResponse.json({ ok: true })
  }

  const sesion = await sesionActual()
  const locationId = locationIdDeSesion(sesion)

  try {
    const data = await crearNota(locationId, contactId, body)
    return NextResponse.json(data)
  } catch (err) {
    console.error(`[POST /api/conversaciones/${id}/notas] error:`, err)
    return NextResponse.json({ error: 'No se pudo guardar la nota' }, { status: 502 })
  }
}
