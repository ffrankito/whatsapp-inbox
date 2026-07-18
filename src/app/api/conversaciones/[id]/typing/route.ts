import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { obtenerConversacion, ultimoMensajeEntranteWaId, puedeEscribir } from '@/lib/standalone/store'
import { enviarIndicadorEscribiendo } from '@/lib/kapso/client'

// Avisa por WhatsApp que el agente está escribiendo (solo tiene sentido en
// STANDALONE_MODE, donde de verdad hablamos con Kapso — ver ARCHITECTURE.md §19). No es
// una acción crítica: si falla, no bloquea nada, así que los errores solo se loguean. Sí
// se verifica que quien pide sea el dueño — si no, cualquiera podría hacerle llegar un
// "escribiendo…" al cliente de una conversación que ni siquiera tiene tomada.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-typing')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ ok: true })
  }

  if (STANDALONE_MODE) {
    const agente = await agenteActual(request)
    const { numero: numeroId } = (await request.json().catch(() => ({}))) as { numero?: NumeroId }
    const conv = obtenerConversacion(id)
    const numero = numeroId ? NUMEROS[numeroId] : undefined
    const waId = conv ? ultimoMensajeEntranteWaId(conv) : undefined
    if (conv && numero && waId && agente && puedeEscribir(conv, agente.id)) {
      enviarIndicadorEscribiendo(numero, waId).catch((err) => {
        console.error(`[POST /api/conversaciones/${id}/typing] error avisando a Kapso:`, err)
      })
    }
    return NextResponse.json({ ok: true })
  }

  // TODO (Fase 6): en modo GHL real todavía no está resuelto — no bloquea nada mientras
  // tanto, la ruta simplemente no hace nada.
  return NextResponse.json({ ok: true })
}
