import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { marcarConversacionVista } from '@/lib/standalone/store'
import { marcarConversacionVistaDemo } from '@/lib/demo/store'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { emitirEvento } from '@/lib/events'

// "Leído" es una propiedad de la conversación (no de quién la mira, ni del navegador
// donde se abrió — antes vivía en localStorage, ver docs/ARCHITECTURE.md §26). Cualquier
// agente que abra la conversación la marca como vista para todos: no requiere ser el
// dueño, mismo criterio que /marcar-leido (el aviso de "leído" hacia el cliente).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-visto')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const { mensajeId } = await request.json().catch(() => ({}))
  if (!mensajeId) {
    return NextResponse.json({ error: 'Falta mensajeId' }, { status: 400 })
  }

  if (DEMO_MODE) {
    marcarConversacionVistaDemo(id, mensajeId)
    return NextResponse.json({ ok: true })
  }

  if (STANDALONE_MODE) {
    const resultado = await marcarConversacionVista(id, mensajeId)
    // Avisa a cualquier otra pestaña/agente mirando este número para que el chip "sin
    // leer" desaparezca ahí también, sin esperar al próximo poll de respaldo (45s).
    if (resultado) emitirEvento({ tipo: 'mensaje', numero: resultado.numero })
    return NextResponse.json({ ok: true })
  }

  // TODO (Fase 6): en modo GHL real, "leído" pasa a resolverse con el propio inbox
  // nativo de GHL — todavía no está definido cómo se refleja acá.
  return NextResponse.json({ ok: true })
}
