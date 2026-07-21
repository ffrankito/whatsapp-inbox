import { NextRequest } from 'next/server'
import { suscribirse } from '@/lib/events'

export const dynamic = 'force-dynamic'

// SSE: mantiene la conexión abierta con /inbox y le reenvía cada evento apenas llega
// (ver ARCHITECTURE.md §5.1). Ojo si en el servidor final hay un reverse proxy delante:
// tiene que tener el buffering desactivado para esta ruta, si no corta el streaming.
export async function GET(request: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const enviar = (evento: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evento)}\n\n`))
        } catch {
          // la conexión ya se cerró, el listener de abort de abajo se encarga de limpiar
        }
      }

      const desuscribirse = suscribirse(enviar)

      // Ping cada 25s para que ningún proxy intermedio corte la conexión por inactividad.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 25_000)

      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        desuscribirse()
        try {
          controller.close()
        } catch {
          // ya estaba cerrado
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
