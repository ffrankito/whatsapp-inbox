import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { cerrarConversacionDemo } from '@/lib/demo/store'
import { cerrarConversacion } from '@/lib/standalone/store'

// Solo el dueño actual puede cerrarla — bug corregido, ver ARCHITECTURE.md §23.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-cerrar')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  if (DEMO_MODE) {
    const ok = cerrarConversacionDemo(id, agente.id)
    if (!ok) return NextResponse.json({ error: 'No sos el dueño de esta conversación' }, { status: 423 })
  } else if (STANDALONE_MODE) {
    const ok = await cerrarConversacion(id, agente.id)
    if (!ok) return NextResponse.json({ error: 'No sos el dueño de esta conversación' }, { status: 423 })
  }

  return NextResponse.json({ ok: true })
}
