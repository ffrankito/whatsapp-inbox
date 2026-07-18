import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { crearNota } from '@/lib/ghl/client'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { agregarNotaDemo } from '@/lib/demo/store'
import { pedidoConfiable } from '@/lib/csrf'

type Body = { contactId: string; body: string }

// Proxy directo a GHL — la nota queda guardada a nivel de contacto en GHL,
// sin tabla propia (ver ARCHITECTURE.md §6 "Notas / auditoría").
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }

  const { contactId, body }: Body = await request.json()
  if (!contactId || !body?.trim()) {
    return NextResponse.json({ error: 'Faltan contactId o body' }, { status: 400 })
  }

  if (DEMO_MODE || STANDALONE_MODE) {
    // Todavía no hay GHL conectado — no hay dónde guardar la nota de verdad.
    console.log(`[${STANDALONE_MODE ? 'standalone' : 'demo'}] nota para ${contactId}: ${body}`)
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
