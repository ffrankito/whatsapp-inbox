import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { obtenerConversacion, ultimoMensajeEntranteWaId } from '@/lib/standalone/store'
import { marcarLeido, buscarUltimoMensajeEntranteEnKapso } from '@/lib/kapso/client'

// Se llama al ABRIR una conversación (no al escribir — eso es /typing, que además manda
// el "escribiendo…"). Es solo un aviso de cortesía hacia el cliente; no requiere ser el
// dueño de la conversación, alcanza con poder identificarse — ver la ficha de Kapso, no
// hay separación de "quién puede ver" vs "quién puede responder" para esto.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-marcar-leido')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  if (DEMO_MODE) {
    return NextResponse.json({ ok: true })
  }

  if (STANDALONE_MODE) {
    const { numero: numeroId } = (await request.json().catch(() => ({}))) as { numero?: NumeroId }
    const conv = await obtenerConversacion(id)
    const numero = numeroId ? NUMEROS[numeroId] : undefined
    const waId = conv ? ultimoMensajeEntranteWaId(conv) ?? (numero ? await buscarUltimoMensajeEntranteEnKapso(numero, conv.phone) : undefined) : undefined
    if (conv && numero && waId) {
      marcarLeido(numero, waId).catch((err) => {
        console.error(`[POST /api/conversaciones/${id}/marcar-leido] error avisando a Kapso:`, err)
      })
    }
    return NextResponse.json({ ok: true })
  }

  // TODO (Fase 6): en modo GHL real todavía no está resuelto — no bloquea nada mientras
  // tanto, la ruta simplemente no hace nada.
  return NextResponse.json({ ok: true })
}
