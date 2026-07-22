import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { actualizarContactoKapso } from '@/lib/kapso/client'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ waId: string }> }) {
  const { waId } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'contactos-actualizar')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const { profileName } = await request.json()
  const nombre = (profileName as string | undefined)?.trim()
  if (!nombre) {
    return NextResponse.json({ error: 'Falta profileName' }, { status: 400 })
  }

  try {
    await actualizarContactoKapso(numero, waId, nombre)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(`[PATCH /api/contactos/${waId}] error actualizando en Kapso (${numeroId}):`, err)
    return NextResponse.json({ error: 'No se pudo actualizar el contacto' }, { status: 502 })
  }
}
