import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { crearNota } from '@/lib/ghl/client'
import { DEMO_MODE, agregarNotaDemo } from '@/lib/demo/store'

type Body = { contactId: string; body: string }

// Proxy directo a GHL — la nota queda guardada a nivel de contacto en GHL,
// sin tabla propia (ver ARCHITECTURE.md §6 "Notas / auditoría").
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { contactId, body }: Body = await _request.json()
  if (!contactId || !body?.trim()) {
    return NextResponse.json({ error: 'Faltan contactId o body' }, { status: 400 })
  }

  if (DEMO_MODE) {
    agregarNotaDemo(contactId, body)
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
