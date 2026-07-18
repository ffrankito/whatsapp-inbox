import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { pedidoConfiable } from '@/lib/csrf'
import { agenteActual } from '@/lib/agente'
import { obtenerConversacion as obtenerDemo, puedeEscribirDemo, agregarMensajeDemo } from '@/lib/demo/store'
import { obtenerConversacion as obtenerStandalone, puedeEscribir, agregarMensaje as agregarMensajeStandalone } from '@/lib/standalone/store'
import { subirMediaAKapso, enviarMediaPorKapso } from '@/lib/kapso/client'
import { emitirEvento } from '@/lib/events'
import type { TipoAdjunto } from '@/lib/mensaje'

const TAMANO_MAXIMO = 8 * 1024 * 1024 // 8MB — alcanza para audios/documentos cortos

function tipoDesdeMime(mime: string): TipoAdjunto {
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

  const formData = await request.formData()
  const archivo = formData.get('archivo') as File | null
  const numeroId = formData.get('numero') as NumeroId | null
  const contactId = formData.get('contactId') as string | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined

  if (!archivo || !numero || !contactId) {
    return NextResponse.json({ error: 'Faltan archivo, numero o contactId' }, { status: 400 })
  }
  if (archivo.size > TAMANO_MAXIMO) {
    return NextResponse.json({ error: 'El archivo es demasiado grande (máximo 8MB)' }, { status: 413 })
  }

  const mime = archivo.type || 'application/octet-stream'
  const tipo = tipoDesdeMime(mime)
  const agente = await agenteActual(request)

  if (DEMO_MODE) {
    const conv = obtenerDemo(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribirDemo(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }
    const url = await comoDataUrl(archivo, mime)
    const nuevo = agregarMensajeDemo(id, '', 'outbound', { url, tipo, nombre: archivo.name })
    return NextResponse.json({ ok: true, messageId: nuevo?.id })
  }

  if (STANDALONE_MODE) {
    const conv = obtenerStandalone(id)
    if (!conv) return NextResponse.json({ error: 'No existe esa conversación' }, { status: 404 })
    if (!agente || !puedeEscribir(conv, agente.id)) {
      return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
    }

    try {
      const mediaId = await subirMediaAKapso(numero, archivo, archivo.name, mime)
      await enviarMediaPorKapso(numero, conv.phone, mediaId, tipo, { nombre: archivo.name })
    } catch (err) {
      console.error(`[POST /api/conversaciones/${id}/adjunto] error enviando por Kapso:`, err)
      return NextResponse.json({ error: 'No se pudo enviar el archivo' }, { status: 502 })
    }

    // Para mostrarlo en nuestro propio hilo alcanza con una vista previa local — Kapso
    // no nos devuelve una URL pública propia para lo que nosotros mandamos.
    const url = await comoDataUrl(archivo, mime)
    const nuevo = agregarMensajeStandalone(id, '', 'outbound', { url, tipo, nombre: archivo.name })
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
