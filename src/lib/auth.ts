import { cookies } from 'next/headers'
import { leerSessionToken, SESSION_COOKIE } from '@/lib/session'
import type { GhlUserContext } from '@/lib/ghl/sso'

export async function sesionActual(): Promise<GhlUserContext | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  try {
    return await leerSessionToken(token)
  } catch {
    return null
  }
}

export function locationIdDeSesion(sesion: GhlUserContext | null): string {
  // Mientras solo exista la location de sandbox, el env var sirve de respaldo
  // si el iframe no llegó a mandar el contexto SSO todavía.
  return sesion?.activeLocation ?? process.env.GHL_LOCATION_ID!
}
