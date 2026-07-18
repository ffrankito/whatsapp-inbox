import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { asignarConversacionDemo } from '@/lib/demo/store'
import { asignarConversacion } from '@/lib/standalone/store'

// "Tomar" la conversación — la asigna al agente que pide, bloqueando que otro agente
// pueda responder mientras tanto (ver ARCHITECTURE.md, bloqueo entre agentes).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-asignar')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  if (DEMO_MODE) {
    const resultado = asignarConversacionDemo(id, agente)
    if (!resultado.ok) {
      const error = resultado.motivo === 'cerrada' ? 'Esta conversación está cerrada' : 'Ya asignada'
      return NextResponse.json({ error, asignadaA: 'asignadaA' in resultado ? resultado.asignadaA : undefined }, { status: 409 })
    }
    return NextResponse.json({ ok: true, asignadaA: agente })
  }

  if (STANDALONE_MODE) {
    const resultado = asignarConversacion(id, agente)
    if (!resultado.ok) {
      const error = resultado.motivo === 'cerrada' ? 'Esta conversación está cerrada' : 'Ya asignada'
      return NextResponse.json({ error, asignadaA: 'asignadaA' in resultado ? resultado.asignadaA : undefined }, { status: 409 })
    }
    return NextResponse.json({ ok: true, asignadaA: agente })
  }

  // TODO (Fase 6): GHL todavía no tiene una tabla propia de asignación — por ahora,
  // en modo real, no se bloquea nada (ver ARCHITECTURE.md, pendiente de diseño).
  return NextResponse.json({ ok: true, asignadaA: agente })
}
