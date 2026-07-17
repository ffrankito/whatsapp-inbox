import { SignJWT, jwtVerify } from 'jose'
import type { GhlUserContext } from '@/lib/ghl/sso'

export const SESSION_COOKIE = 's24wpp_session'
const SESSION_TTL_SECONDS = 60 * 60 * 8 // 8 horas, se vuelve a pedir el contexto SSO al recargar el iframe

function secretKey() {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET no configurado')
  return new TextEncoder().encode(secret)
}

export async function crearSessionToken(user: GhlUserContext): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey())
}

export async function leerSessionToken(token: string): Promise<GhlUserContext> {
  const { payload } = await jwtVerify(token, secretKey())
  return payload as unknown as GhlUserContext
}
