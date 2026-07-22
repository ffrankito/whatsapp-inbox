import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { agenteActual } from '@/lib/agente'
import { listarContactosKapso } from '@/lib/kapso/client'

// Agenda de contactos por número — ver ARCHITECTURE.md, "Asignación / bloqueo entre
// agentes": ver no requiere ser dueño de nada, alcanza con ser un agente identificado
// (mismo criterio que /api/conversaciones).
export async function GET(request: NextRequest) {
  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const q = request.nextUrl.searchParams.get('q') ?? undefined

  try {
    const contactos = await listarContactosKapso(numero, { search: q, limit: 50 })
    return NextResponse.json({ contactos })
  } catch (err) {
    console.error(`[GET /api/contactos] error consultando Kapso (${numeroId}):`, err)
    return NextResponse.json({ error: 'No se pudieron obtener los contactos' }, { status: 502 })
  }
}
