import { NextRequest, NextResponse } from 'next/server'
import { Readable } from 'node:stream'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { obtenerConversacion as obtenerDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone } from '@/lib/standalone/store'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { inferirContentType } from '@/lib/mime'
import { esReferenciaStorage, descargarArchivo } from '@/lib/storage'

// Dos fuentes posibles para un adjunto, las dos requieren pasar por acá para abrirse
// inline en vez de forzar "Guardar como":
// 1. Kapso espeja los adjuntos entrantes a una URL propia (ver parseWebhook.ts) —
//    manda Content-Disposition: attachment, y como es cross-origin el atributo
//    `download` del <a> no tiene ningún efecto sobre eso, hay que hacer el fetch
//    nosotros y devolver la respuesta sin ese header.
// 2. Los que ya se persistieron en nuestro storage propio (MinIO, ver src/lib/storage.ts,
//    tanto entrantes re-hosteados como salientes que mandamos nosotros) — el bucket es
//    privado a propósito, así que también hay que pasar por acá (con la misma
//    autenticación del resto de la app) en vez de exponer un link público directo.
const KAPSO_HOST_SUFFIX = '.kapso.ai'

function esHostKapsoConfiable(hostname: string): boolean {
  return hostname === 'kapso.ai' || hostname.endsWith(KAPSO_HOST_SUFFIX)
}

// Sin el chequeo de CSRF (pedidoConfiable) a propósito: es una ruta GET de solo lectura,
// sin ningún efecto secundario, y <img>/<video>/<audio> src="..." no pueden mandar el
// header custom que exige esa función — un atacante que logre disparar este GET desde
// otro sitio igual no puede LEER la respuesta (el navegador se lo bloquea por CORS, no
// mandamos Access-Control-Allow-Origin), así que no hay nada que proteger acá que
// agenteActual() no cubra ya. Mismo criterio que el resto de las rutas GET de la app
// (conversaciones, contactos, etc.), ninguna exige este header tampoco.
export async function GET(request: NextRequest) {
  if (accionLimitada(request, 'adjunto-proxy')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }
  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'Falta identidad de agente' }, { status: 401 })
  }

  const conversacionId = request.nextUrl.searchParams.get('conversacionId')
  const mensajeId = request.nextUrl.searchParams.get('mensajeId')
  if (!conversacionId || !mensajeId) {
    return NextResponse.json({ error: 'Faltan conversacionId o mensajeId' }, { status: 400 })
  }

  let adjunto: { url: string; nombre?: string } | undefined

  if (DEMO_MODE) {
    const conv = obtenerDemo(conversacionId)
    adjunto = conv?.mensajes.find((m) => m.id === mensajeId)?.adjunto
  } else if (STANDALONE_MODE) {
    const conv = await obtenerStandalone(conversacionId)
    adjunto = conv?.mensajes.find((m) => m.id === mensajeId)?.adjunto ?? undefined
  } else {
    // Fase 6 (GHL como fuente de verdad) todavía no está implementada — el esquema real
    // de adjuntos que devuelve GHL no está confirmado todavía (ver ARCHITECTURE.md §16).
    return NextResponse.json({ error: 'No implementado en este modo' }, { status: 501 })
  }

  if (!adjunto) {
    return NextResponse.json({ error: 'No existe ese adjunto' }, { status: 404 })
  }

  // Mensajes de antes de este cambio pueden seguir teniendo el adjunto como `data:` URL
  // propia (base64 adentro de Postgres) — esos no pasan por acá, el frontend los linkea
  // directo. Si llega uno así de todas formas, no hay nada que proxear.
  if (esReferenciaStorage(adjunto.url)) {
    const archivo = await descargarArchivo(adjunto.url)
    if (!archivo) {
      return NextResponse.json({ error: 'No se pudo obtener el adjunto de nuestro storage' }, { status: 502 })
    }
    const contentType = inferirContentType(adjunto.nombre, archivo.contentType)
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (archivo.contentLength) headers['Content-Length'] = String(archivo.contentLength)
    // A propósito SIN Content-Disposition: attachment — mismo criterio que el caso de
    // Kapso más abajo, así el navegador lo abre inline en vez de forzar "Guardar como".
    return new Response(Readable.toWeb(archivo.body) as ReadableStream, { headers })
  }

  if (!adjunto.url.startsWith('http://') && !adjunto.url.startsWith('https://')) {
    return NextResponse.json({ error: 'Ese adjunto no se proxea' }, { status: 400 })
  }

  let destino: URL
  try {
    destino = new URL(adjunto.url)
  } catch {
    return NextResponse.json({ error: 'URL de adjunto inválida' }, { status: 400 })
  }

  // Nunca hacer fetch de una URL fuera de Kapso — si no, esto sería un proxy abierto
  // (SSRF) que cualquiera podría usar para pegarle a cualquier host desde nuestro server.
  if (!esHostKapsoConfiable(destino.hostname)) {
    console.error('[adjunto/proxy] host no confiable, se rechaza:', destino.hostname)
    return NextResponse.json({ error: 'Host de adjunto no permitido' }, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(destino)
  } catch (err) {
    console.error('[adjunto/proxy] error pidiendo el archivo a Kapso:', err)
    return NextResponse.json({ error: 'No se pudo obtener el adjunto' }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Kapso no devolvió el archivo' }, { status: 502 })
  }

  const contentType = inferirContentType(adjunto.nombre, upstream.headers.get('content-type'))
  const headers: Record<string, string> = { 'Content-Type': contentType }
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers['Content-Length'] = contentLength

  // A propósito SIN Content-Disposition: attachment — así el navegador lo abre inline
  // (visor nativo de PDF, etc.) en vez de forzar "Guardar como".
  return new Response(upstream.body, { headers })
}
