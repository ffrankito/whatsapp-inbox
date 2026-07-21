import { SignJWT, jwtVerify } from 'jose'
import type { GhlUserContext } from '@/lib/ghl/sso'
import type { AgenteGoogle } from '@/lib/google/verificar'

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

// Cookie separada para el login con Google (temporal, ver docs/BACKLOG.md #1) — no se
// reusa SESSION_COOKIE porque esa representa el contexto SSO del iframe de GHL, una cosa
// distinta que en la Fase 6 va a reemplazar a esta. Mismo secreto de firma, misma lógica.
export const AGENTE_COOKIE = 's24wpp_agente'
const AGENTE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 días — a diferencia del contexto de GHL, esto no depende de un iframe que se recarga

export async function crearAgenteToken(agente: AgenteGoogle): Promise<string> {
  return new SignJWT({ ...agente })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${AGENTE_TTL_SECONDS}s`)
    .sign(secretKey())
}

export async function leerAgenteToken(token: string): Promise<AgenteGoogle> {
  const { payload } = await jwtVerify(token, secretKey())
  return payload as unknown as AgenteGoogle
}
