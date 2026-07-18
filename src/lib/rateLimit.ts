import type { NextRequest } from 'next/server'

// Rate limit simple en memoria — alcanza porque corre como proceso Docker persistente
// (no serverless). Si en el futuro hay más de una réplica, esto deja de ser exacto
// (cada réplica cuenta por separado) pero sigue funcionando como mitigación básica.
const buckets = new Map<string, { count: number; resetAt: number }>()

function limitado(key: string, limite: number, ventanaMs: number): boolean {
  const ahora = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || ahora > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: ahora + ventanaMs })
    return false
  }
  bucket.count += 1
  return bucket.count > limite
}

function ipDe(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

// 60 pedidos por minuto por IP y por ruta — generoso para webhooks legítimos
// (Kapso/GHL reintentan, pero no a ese ritmo), corta un flood.
export function webhookLimitado(request: NextRequest, ruta: string): boolean {
  return limitado(`${ruta}:${ipDe(request)}`, 60, 60_000)
}

// Para las rutas que un agente dispara con clicks (responder, tomar, adjunto, etc.) —
// mientras la identidad de agente sea auto-declarada por header y no haya login real
// (ver ARCHITECTURE.md §18 y §23), esto es la única traba contra alguien con acceso a la
// API mandando pedidos en loop. 120/min por IP y por ruta: muy por encima de lo que
// cualquier humano clickeando llega a generar, pero corta un script.
export function accionLimitada(request: NextRequest, ruta: string): boolean {
  return limitado(`accion-${ruta}:${ipDe(request)}`, 120, 60_000)
}
