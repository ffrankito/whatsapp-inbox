import { NextRequest, NextResponse } from 'next/server'
import { sesionActual, locationIdDeSesion } from '@/lib/auth'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { buscarConversaciones } from '@/lib/ghl/client'
import { DEMO_MODE, listarConversaciones } from '@/lib/demo/store'

export async function GET(request: NextRequest) {
  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  if (DEMO_MODE) {
    const conversations = listarConversaciones(numeroId!).map((c) => ({
      id: c.id,
      contactId: c.contactId,
      fullName: c.fullName,
      phone: c.phone,
      lastMessageBody: c.mensajes.at(-1)?.body,
      unreadCount: c.unreadCount,
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
