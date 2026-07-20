import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { traspasarConversacionDemo } from '@/lib/demo/store'
import { traspasarConversacion } from '@/lib/standalone/store'
import type { Agente } from '@/lib/standalone/store'

type Body = { agenteId: string; agenteNombre: string }

// El dueño actual le pasa la conversación directo a otro agente conocido (ver
// ARCHITECTURE.md §20) — sigue asignada todo el tiempo, no pasa por "sin_asignar".
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-traspasar')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const { agenteId, agenteNombre }: Body = await request.json()
  if (!agenteId || !agenteNombre) {
    return NextResponse.json({ error: 'Falta el agente destino' }, { status: 400 })
  }
  const destino: Agente = { id: agenteId, nombre: agenteNombre }

  if (DEMO_MODE) {
    const resultado = traspasarConversacionDemo(id, agente.id, destino)
    if (!resultado.ok) {
      return NextResponse.json({ error: 'No se pudo traspasar' }, { status: resultado.motivo === 'no_existe' ? 404 : 423 })
    }
    return NextResponse.json({ ok: true, asignadaA: destino })
  }

  if (STANDALONE_MODE) {
    const resultado = await traspasarConversacion(id, agente.id, destino)
    if (!resultado.ok) {
      return NextResponse.json({ error: 'No se pudo traspasar' }, { status: resultado.motivo === 'no_existe' ? 404 : 423 })
    }
    return NextResponse.json({ ok: true, asignadaA: destino })
  }

  // TODO (Fase 6): GHL todavía no tiene una tabla propia de asignación (ver asignar/route.ts).
  return NextResponse.json({ ok: true, asignadaA: destino })
}
