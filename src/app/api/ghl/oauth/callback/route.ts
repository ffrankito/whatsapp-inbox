import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForInstall } from '@/lib/ghl/client'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.json({ error: 'Falta el parámetro "code"' }, { status: 400 })
  }

  try {
    const locationId = await exchangeCodeForInstall(code)
    return NextResponse.json({ ok: true, locationId })
  } catch (err) {
    console.error('[GHL oauth callback] error intercambiando code:', err)
    return NextResponse.json({ error: 'No se pudo completar la instalación' }, { status: 500 })
  }
}
