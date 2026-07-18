import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { liberarConversacionDemo } from '@/lib/demo/store'
import { liberarConversacion } from '@/lib/standalone/store'

// Devuelve la conversación al pool sin asignar — cualquier agente puede tomarla de nuevo.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }

  if (DEMO_MODE) {
    liberarConversacionDemo(id)
  } else if (STANDALONE_MODE) {
    liberarConversacion(id)
  }

  return NextResponse.json({ ok: true })
}
