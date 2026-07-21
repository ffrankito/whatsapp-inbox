import { createRemoteJWKSet, jwtVerify } from 'jose'

// Login temporal con Google (hasta que llegue el SSO de GHL en la Fase 6, ver
// docs/BACKLOG.md #1). Se verifica el ID token de Google Identity Services directo
// contra su JWKS público — no hace falta client secret ni intercambio server-to-server,
// solo confirmar que la firma es de Google y que el token es para esta app.
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

export type AgenteGoogle = { id: string; nombre: string; email: string }

/**
 * Verifica un ID token de Google (el `credential` que manda Google Identity Services al
 * loguearse) y devuelve la identidad si es válido y pertenece al dominio permitido.
 * Devuelve null ante cualquier problema (firma inválida, expirado, dominio ajeno, etc.)
 * — el llamador decide qué responder, acá solo se verifica.
 */
export async function verificarCredencialGoogle(credential: string): Promise<AgenteGoogle | null> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
  const dominioPermitido = process.env.GOOGLE_ALLOWED_DOMAIN
  if (!clientId || !dominioPermitido) {
    console.error('[google/verificar] faltan NEXT_PUBLIC_GOOGLE_CLIENT_ID o GOOGLE_ALLOWED_DOMAIN')
    return null
  }

  let payload
  try {
    ;({ payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    }))
  } catch {
    return null
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined
  const emailVerificado = payload.email_verified === true
  const nombre = typeof payload.name === 'string' ? payload.name : email
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined

  if (!sub || !email || !nombre || !emailVerificado) return null

  // El claim `hd` (hosted domain) solo viene si la cuenta es de Google Workspace — para
  // no depender de que Google siempre lo mande, se valida también contra el email.
  const hd = typeof payload.hd === 'string' ? payload.hd : undefined
  const dominioDelEmail = email.split('@')[1]?.toLowerCase()
  if (hd !== dominioPermitido && dominioDelEmail !== dominioPermitido.toLowerCase()) {
    return null
  }

  return { id: sub, nombre, email }
}
