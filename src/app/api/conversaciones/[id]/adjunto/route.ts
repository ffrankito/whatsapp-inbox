import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { agenteActual } from '@/lib/agente'
import { obtenerConversacion as obtenerDemo, puedeEscribirDemo, agregarMensajeDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone, puedeEscribir, agregarMensaje as agregarMensajeStandalone } from '@/lib/standalone/store'
import { subirMediaAKapso, enviarMediaPorKapso } from '@/lib/kapso/client'
import { subirArchivo } from '@/lib/storage'
import { emitirEvento } from '@/lib/events'
import type { TipoAdjunto } from '@/lib/mensaje'

const TAMANO_MAXIMO = 8 * 1024 * 1024 // 8MB — alcanza para audios/documentos cortos
// Límite propio de WhatsApp para stickers (docs.kapso.ai, "Send sticker"): 100KB
// estáticos / 500KB animados. No se distingue acá cuál es cuál (habría que parsear el
// WEBP) — se usa el tope más permisivo, así igual corta un archivo muy grande antes de
// mandarlo, en vez de depender del 502 genérico de Kapso para avisar.
const TAMANO_MAXIMO_STICKER = 500 * 1024

function tipoDesdeMime(mime: string): TipoAdjunto {
  // WhatsApp trata los stickers como un tipo de mensaje aparte (type: "sticker"), no
  // como una imagen más — sin esto, un .webp se mandaría como imagen normal en vez de
  // aparecer como sticker real en el WhatsApp del cliente.
  if (mime === 'image/webp') return 'sticker'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

// Manda un archivo (imagen/audio/documento/video) — en STANDALONE_MODE sale de verdad
// por WhatsApp vía Kapso; en DEMO_MODE queda solo en memoria como vista previa.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'conversaciones-adjunto')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  // Cortar por Content-Length ANTES de bufferear el body entero con formData() — así una
  // subida mucho más grande que el límite no fuerza al proceso a leerla igual antes de
  // rechazarla (margen de 64KB para el overhead propio del multipart).
  const declarado = Number(request.headers.get('content-length') ?? 0)
  if (declarado > TAMANO_MAXIMO + 64 * 1024) {
    return NextResponse.json({ error: 'El archivo es demasiado grande (máximo 8MB)' }, { status: 413 })
  }

  const formData = await request.formData()
  const archivo = formData.get('archivo') as File | null
  const numeroId = formData.get('numero') as NumeroId | null
  const contactId = formData.get('contactId') as string | null
  const caption = (formData.get('caption') as string | null)?.trim() || undefined
  const numero = numeroId ? NUMEROS[numeroId] : undefined

  if (!archivo || !numero || !contactId) {
    return NextResponse.json({ error: 'Faltan archivo, numero o contactId' }, { status: 400 })
  }
  if (archivo.size > TAMANO_MAXIMO) {
    return NextResponse.json({ error: 'El archivo es demasiado grande (máximo 8MB)' }, { status: 413 })
  }

  const mime = archivo.type || 'application/octet-stream'
  const tipo = tipoDesdeMime(mime)
  if (tipo === 'sticker' && archivo.size > TAMANO_MAXIMO_STICKER) {
    return NextResponse.json({ error: 'El sticker es demasiado grande (máximo 500KB)' }, { status: 413 })
  }
  const agente = await agenteActual(request)

  if (DEMO_MODE) {
    const conv = obtenerDemo(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribirDemo(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }
    const url = await comoDataUrl(archivo, mime)
    const nuevo = agregarMensajeDemo(id, caption ?? '', 'outbound', { url, tipo, nombre: archivo.name })
    return NextResponse.json({ ok: true, messageId: nuevo?.id })
  }

  if (STANDALONE_MODE) {
    const conv = await obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribir(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }

    // El audio y los stickers no soportan caption en la API de WhatsApp — se manda sin,
    // aunque hayan escrito algo (se descarta silenciosamente, igual que hace Meta).
    const captionParaEnviar = tipo === 'audio' || tipo === 'sticker' ? undefined : caption
    let waId: string | undefined
    try {
      const mediaId = await subirMediaAKapso(numero, archivo, archivo.name, mime)
      const data = await enviarMediaPorKapso(numero, conv.phone, mediaId, tipo, { nombre: archivo.name, caption: captionParaEnviar })
      waId = data.messages?.[0]?.id
    } catch (err) {
      console.error(`[POST /api/conversaciones/${id}/adjunto] error enviando por Kapso:`, err)
      return NextResponse.json({ error: 'No se pudo enviar el archivo' }, { status: 502 })
    }

    // Para mostrarlo en nuestro propio hilo hace falta guardar el archivo — Kapso no nos
    // devuelve una URL pública propia para lo que nosotros mandamos. Va a nuestro storage
    // propio (MinIO, ver src/lib/storage.ts), no como base64 adentro de Postgres.
    const url = await subirArchivo(Buffer.from(await archivo.arrayBuffer()), mime, archivo.name)
    const nuevo = await agregarMensajeStandalone(id, captionParaEnviar ?? '', 'outbound', { url, tipo, nombre: archivo.name }, { status: 'sent', waId })
    emitirEvento({ tipo: 'mensaje', numero: numero.id })
    return NextResponse.json({ ok: true, messageId: nuevo?.id })
  }

  // TODO (Fase 6): en modo real (GHL) hace falta una URL pública de verdad para el
  // campo `attachments` de GHL — todavía no está resuelto dónde se hostea (ver
  // ARCHITECTURE.md). Por ahora, no soportado.
  return NextResponse.json({ error: 'Envío de adjuntos no soportado todavía en este modo' }, { status: 501 })
}

async function comoDataUrl(archivo: File, mime: string): Promise<string> {
  const buffer = Buffer.from(await archivo.arrayBuffer())
  return `data:${mime};base64,${buffer.toString('base64')}`
}
