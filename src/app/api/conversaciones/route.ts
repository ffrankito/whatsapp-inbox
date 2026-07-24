import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { buscarConversaciones } from '@/lib/ghl/client'
import { DEMO_MODE, STANDALONE_MODE } from '@/lib/mode'
import { agenteActual } from '@/lib/agente'
import { listarConversaciones as listarDemo } from '@/lib/demo/store'
import { listarConversaciones as listarStandalone } from '@/lib/standalone/store'

export async function GET(request: NextRequest) {
  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  // Ver conversaciones no requiere ser el dueño de cada una (eso es solo para escribir,
  // ver ARCHITECTURE.md §18), pero sí requiere ser un agente identificado — si no, es un
  // IDOR: cualquiera con el id/número podía leer conversaciones ajenas (ver BACKLOG.md #14).
  if (DEMO_MODE || STANDALONE_MODE) {
    const agente = await agenteActual(request)
    if (!agente) {
      return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
    }
  }

  if (DEMO_MODE) {
    const conversations = listarDemo(numeroId!).map((c) => ({
      id: c.id,
      contactId: c.contactId,
      fullName: c.fullName,
      phone: c.phone,
      lastMessageBody: c.mensajes.at(-1)?.body,
      lastMessageId: c.mensajes.at(-1)?.id,
      lastMessageAdjuntoTipo: c.mensajes.at(-1)?.adjunto?.tipo,
      unreadCount: c.unreadCount,
      estado: c.estado,
      asignadaA: c.asignadaA,
      vistoHastaMensajeId: c.vistoHastaMensajeId,
    }))
    return NextResponse.json({ conversations })
  }

  if (STANDALONE_MODE) {
    const lista = await listarStandalone(numeroId!)
    const conversations = lista.map((c) => ({
      id: c.id,
      contactId: c.contactId,
      fullName: c.fullName,
      phone: c.phone,
      lastMessageBody: c.ultimoMensaje?.body,
      lastMessageId: c.ultimoMensaje?.id,
      lastMessageAdjuntoTipo: c.ultimoMensaje?.adjunto?.tipo,
      unreadCount: 0,
      estado: c.estado,
      asignadaA: c.asignadaA,
      ultimoAgente: c.ultimoAgente,
      ultimoAgenteEn: c.ultimoAgenteEn,
      vistoHastaMensajeId: c.vistoHastaMensajeId,
    }))
    return NextResponse.json({ conversations })
  }

  const sesion = await sesionActual()
  const locationId = locationIdDeSesion(sesion)

  try {
    const data = await buscarConversaciones(locationId, numero.conversationProviderId)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[GET /api/conversaciones] error consultando GHL:', err)
    return NextResponse.json({ error: 'No se pudieron obtener las conversaciones' }, { status: 502 })
  }
}
