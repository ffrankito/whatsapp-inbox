import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { mensajesDeConversacion } from '@/lib/ghl/client'
import { DEMO_MODE, obtenerConversacion } from '@/lib/demo/store'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (DEMO_MODE) {
    const conv = obtenerConversacion(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    return NextResponse.json({ messages: { messages: conv.mensajes } })
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
