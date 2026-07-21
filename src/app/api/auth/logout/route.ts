import { NextRequest, NextResponse } from 'next/server'
import { AGENTE_COOKIE } from '@/lib/session'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'

export async function POST(request: NextRequest) {
  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'auth-logout')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.delete(AGENTE_COOKIE)
  return res
}
