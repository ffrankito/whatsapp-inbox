import { NextRequest, NextResponse } from 'next/server'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { obtenerConversacion as obtenerDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone } from '@/lib/standalone/store'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'

// Kapso espeja los adjuntos entrantes a una URL propia (ver parseWebhook.ts) — nunca se
// re-hostea en storage propio (ARCHITECTURE.md §17). Esta ruta existe solo para que los
// documentos (PDF/DOCX/etc.) se abran inline en el navegador en vez de forzar "Guardar
// como": Kapso manda Content-Disposition: attachment para esos, y como adjunto.url es
// cross-origin, el atributo `download` del <a> no tiene ningún efecto sobre eso — el
// único jeito de controlar la respuesta es haciendo el fetch nosotros y devolviéndola sin
// ese header. No se usa para imagen/audio/video: esos ya se ven bien porque Kapso no les
// manda ese header.
const KAPSO_HOST_SUFFIX = '.kapso.ai'

function esHostKapsoConfiable(hostname: string): boolean {
  return hostname === 'kapso.ai' || hostname.endsWith(KAPSO_HOST_SUFFIX)
}

const MIME_POR_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
}

function inferirContentType(nombre: string | undefined, contentTypeDeKapso: string | null): string {
  // "application/octet-stream" es lo que manda cualquier server que no supo inferir el
  // tipo — no sirve para que el navegador elija el visor nativo, así que en ese caso (o
  // si directamente no vino el header) se intenta inferir por extensión del nombre.
  if (contentTypeDeKapso && contentTypeDeKapso !== 'application/octet-stream') return contentTypeDeKapso
  const extension = nombre?.split('.').pop()?.toLowerCase()
  return (extension && MIME_POR_EXTENSION[extension]) || contentTypeDeKapso || 'application/octet-stream'
}

export async function GET(request: NextRequest) {
  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
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

  // Los adjuntos salientes en modo standalone se guardan como `data:` URL propia (no hay
  // storage externo, ver ARCHITECTURE.md §17) — esos no pasan por acá, el frontend los
  // linkea directo. Si llega uno así de todas formas, no hay nada que proxear.
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
