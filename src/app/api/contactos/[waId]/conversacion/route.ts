import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { agenteActual } from '@/lib/agente'
import { idParaTelefono, obtenerConversacion } from '@/lib/standalone/store'

// Resuelve si un contacto de la agenda ya tiene una conversación en nuestra base —
// el id se deriva de forma determinística (numero + teléfono), así que alcanza con
// confirmar que existe de verdad antes de mandar al frontend a abrirla. Si no existe,
// no se ofrece iniciar una nueva acá (requiere mensaje de plantilla — ver BACKLOG.md).
export async function GET(request: NextRequest, { params }: { params: Promise<{ waId: string }> }) {
  const { waId } = await params

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  if (!numeroId || !NUMEROS[numeroId]) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const id = idParaTelefono(numeroId, waId)
  const conv = await obtenerConversacion(id)
  return NextResponse.json({ conversacionId: conv ? id : null })
}
