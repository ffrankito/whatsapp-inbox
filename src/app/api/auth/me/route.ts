import { NextRequest, NextResponse } from 'next/server'
import { leerAgenteToken, AGENTE_COOKIE } from '@/lib/session'

// Se llama una vez al cargar /inbox para restaurar la sesión sin volver a pedir login
// (la cookie ya alcanza — no hace falta guardar nada en localStorage como antes).
export async function GET(request: NextRequest) {
  const token = request.cookies.get(AGENTE_COOKIE)?.value
  if (!token) return NextResponse.json({ agente: null })

  try {
    const agente = await leerAgenteToken(token)
    return NextResponse.json({ agente: { id: agente.id, nombre: agente.nombre } })
  } catch {
    return NextResponse.json({ agente: null })
  }
}
