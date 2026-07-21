import type { NextRequest } from 'next/server'
import { sesionActual } from '@/lib/auth'
import type { Agente } from '@/lib/standalone/store'
import { registrarAgente } from '@/lib/agentesConocidos'
import { leerAgenteToken, AGENTE_COOKIE } from '@/lib/session'

/**
 * Identidad del agente que hace el pedido.
 *
 * - En modo real (GHL conectado, Fase 6+): viene del contexto SSO, ya autenticado
 *   por GHL — es la fuente confiable.
 * - Mientras tanto (Fases 1–5, sin GHL todavía): viene del login con Google
 *   (`AGENTE_COOKIE`, ver docs/BACKLOG.md #1 y src/app/api/auth/google/route.ts),
 *   verificado server-side contra el dominio de la empresa.
 *
 * Antes existía acá un tercer fallback que confiaba en headers mandados por el
 * cliente (`x-s24-agente-id`/`-nombre`) sin ninguna verificación — cualquiera podía
 * suplantar a cualquier agente con solo mandar esos headers. Se sacó al agregar el
 * login con Google: ahora la única forma de identificarse es una cookie firmada
 * server-side, no algo que el cliente pueda declarar.
 */
export async function agenteActual(request: NextRequest): Promise<Agente | null> {
  const sesion = await sesionActual()
  if (sesion?.userId) {
    const agente = { id: sesion.userId, nombre: sesion.userName || sesion.email || 'Agente' }
    registrarAgente(agente)
    return agente
  }

  const token = request.cookies.get(AGENTE_COOKIE)?.value
  if (token) {
    try {
      const { id, nombre } = await leerAgenteToken(token)
      const agente = { id, nombre }
      registrarAgente(agente)
      return agente
    } catch {
      // cookie inválida/expirada — se trata como no logueado
    }
  }

  return null
}
