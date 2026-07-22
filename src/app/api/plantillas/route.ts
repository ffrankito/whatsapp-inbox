import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { agenteActual } from '@/lib/agente'

// Solo devuelve id + etiqueta — el frontend no necesita (ni debería tener) el nombre de
// la plantilla de Meta ni el texto exacto, eso se resuelve server-side al mandar.
export async function GET(request: NextRequest) {
  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const plantillas = numero.plantillasRapidas.map((p) => ({ id: p.id, etiqueta: p.etiqueta }))
  return NextResponse.json({ plantillas })
}
