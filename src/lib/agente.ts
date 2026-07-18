import type { NextRequest } from 'next/server'
import { sesionActual } from '@/lib/auth'
import type { Agente } from '@/lib/standalone/store'
import { registrarAgente } from '@/lib/agentesConocidos'

/**
 * Identidad del agente que hace el pedido.
 *
 * - En modo real (GHL conectado, Fase 6+): viene del contexto SSO, ya autenticado
 *   por GHL — es la fuente confiable.
 * - En modo demo/standalone (Fases 1–2, sin GHL todavía): no hay login real. El
 *   frontend genera un id/nombre de prueba una vez (ver src/app/inbox/page.tsx,
 *   `usarAgenteLocal`) y lo manda en headers propios — alcanza para probar el
 *   bloqueo entre agentes con varias pestañas/navegadores, no es autenticación real.
 */
export async function agenteActual(request: NextRequest): Promise<Agente | null> {
  const sesion = await sesionActual()
  if (sesion?.userId) {
    const agente = { id: sesion.userId, nombre: sesion.userName || sesion.email || 'Agente' }
    registrarAgente(agente)
    return agente
  }

  const id = request.headers.get('x-s24-agente-id')
  const nombre = request.headers.get('x-s24-agente-nombre')
  if (id && nombre) {
    const agente = { id, nombre }
    registrarAgente(agente)
    return agente
  }

  return null
}
