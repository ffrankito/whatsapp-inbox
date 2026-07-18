import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { cerrarConversacionDemo } from '@/lib/demo/store'
import { cerrarConversacion } from '@/lib/standalone/store'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }

  if (DEMO_MODE) {
    cerrarConversacionDemo(id)
  } else if (STANDALONE_MODE) {
    cerrarConversacion(id)
  }

  return NextResponse.json({ ok: true })
}
