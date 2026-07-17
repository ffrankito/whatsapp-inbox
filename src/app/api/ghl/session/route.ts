import { NextRequest, NextResponse } from 'next/server'
import { decryptGhlUserContext } from '@/lib/ghl/sso'
import { crearSessionToken, SESSION_COOKIE } from '@/lib/session'

export async function POST(request: NextRequest) {
  const { encryptedPayload } = await request.json()
  if (!encryptedPayload) {
    return NextResponse.json({ error: 'Falta encryptedPayload' }, { status: 400 })
  }

  let userContext
  try {
    userContext = decryptGhlUserContext(encryptedPayload)
  } catch (err) {
    console.error('[GHL session] error descifrando payload SSO:', err)
    return NextResponse.json({ error: 'Payload SSO inválido' }, { status: 401 })
  }

  const token = await crearSessionToken(userContext)

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none', // el inbox corre dentro de un iframe de terceros (Custom Menu Link de GHL)
    path: '/',
    maxAge: 60 * 60 * 8,
  })
  return res
}
