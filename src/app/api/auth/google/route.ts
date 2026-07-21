import { NextRequest, NextResponse } from 'next/server'
import { verificarCredencialGoogle } from '@/lib/google/verificar'
import { crearAgenteToken, AGENTE_COOKIE } from '@/lib/session'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'

// Login temporal con Google (hasta el SSO de GHL en la Fase 6, ver docs/BACKLOG.md #1) —
// reemplaza el gate de "¿Quién sos?" por una identidad de verdad, restringida al dominio
// de la empresa.
export async function POST(request: NextRequest) {
  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'auth-google')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const { credential } = await request.json()
  if (!credential) {
    return NextResponse.json({ error: 'Falta credential' }, { status: 400 })
  }

  const agente = await verificarCredencialGoogle(credential)
  if (!agente) {
    return NextResponse.json({ error: 'Token de Google inválido o fuera del dominio permitido' }, { status: 401 })
  }

  const token = await crearAgenteToken(agente)

  const res = NextResponse.json({ ok: true, agente: { id: agente.id, nombre: agente.nombre } })
  res.cookies.set(AGENTE_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none', // mismo criterio que SESSION_COOKIE: tiene que sobrevivir dentro del iframe de GHL más adelante
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return res
}
