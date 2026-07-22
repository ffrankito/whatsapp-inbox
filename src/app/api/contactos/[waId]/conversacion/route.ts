import { NextRequest, NextResponse } from 'next/server'
import { NUMEROS, type NumeroId } from '@/lib/ghl/numeros'
import { agenteActual } from '@/lib/agente'
import { idParaTelefono, obtenerConversacion, encontrarOCrearConversacion, agregarMensaje, puedeEscribir } from '@/lib/standalone/store'
import { pedidoConfiable } from '@/lib/csrf'
import { accionLimitada } from '@/lib/rateLimit'
import { enviarPlantillaPorKapso } from '@/lib/kapso/client'
import { emitirEvento } from '@/lib/events'

// Resuelve si un contacto de la agenda ya tiene una conversación en nuestra base —
// el id se deriva de forma determinística (numero + teléfono), así que alcanza con
// confirmar que existe de verdad antes de mandar al frontend a abrirla. Si no existe,
// no se ofrece iniciar una nueva acá (requiere mensaje de plantilla — ver BACKLOG.md).
export async function GET(request: NextRequest, { params }: { params: Promise<{ waId: string }> }) {
  const { waId } = await params

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  if (!numeroId || !NUMEROS[numeroId]) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }

  const id = idParaTelefono(numeroId, waId)
  const conv = await obtenerConversacion(id)
  return NextResponse.json({ conversacionId: conv ? id : null })
}

// Arranca una conversación nueva con un contacto que nunca escribió (o que está fuera
// de la ventana de 24hs) — el único mensaje que WhatsApp permite en ese caso es una
// plantilla (HSM) ya aprobada por Meta, no texto libre (ver docs/BACKLOG.md #6).
export async function POST(request: NextRequest, { params }: { params: Promise<{ waId: string }> }) {
  const { waId } = await params

  if (!pedidoConfiable(request)) {
    return NextResponse.json({ error: 'Origen no confiable' }, { status: 403 })
  }
  if (accionLimitada(request, 'contactos-conversacion')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const agente = await agenteActual(request)
  if (!agente) {
    return NextResponse.json({ error: 'No se pudo identificar al agente' }, { status: 401 })
  }

  const numeroId = request.nextUrl.searchParams.get('numero') as NumeroId | null
  const numero = numeroId ? NUMEROS[numeroId] : undefined
  if (!numero) {
    return NextResponse.json({ error: 'Falta o es inválido el parámetro "numero"' }, { status: 400 })
  }
  if (numero.plantillasRapidas.length === 0) {
    return NextResponse.json({ error: `${numero.nombre} todavía no tiene ninguna plantilla aprobada` }, { status: 400 })
  }

  const { nombre, plantillaId } = await request.json().catch(() => ({}))
  const plantilla = plantillaId ? numero.plantillasRapidas.find((p) => p.id === plantillaId) : numero.plantillasRapidas[0]
  if (!plantilla) {
    return NextResponse.json({ error: 'Esa plantilla no existe para este número' }, { status: 400 })
  }
  const nombreParaSaludo: string = nombre?.trim() || waId

  // Si la conversación ya existe y está tomada por OTRO agente, no se puede mandar nada
  // ahí — mismo criterio de dueño que responder/adjunto/reaccion/notas (ver
  // ARCHITECTURE.md §18). Si no existe todavía (contacto nuevo desde la Agenda) o está
  // sin_asignar, no hay dueño que proteger, se puede arrancar sin más.
  const existente = await obtenerConversacion(idParaTelefono(numeroId!, waId))
  if (existente && !puedeEscribir(existente, agente.id) && existente.estado === 'asignada') {
    return NextResponse.json({ error: 'Esta conversación está asignada a otro agente' }, { status: 423 })
  }

  const conv = await encontrarOCrearConversacion(numeroId!, waId, nombre?.trim() || undefined)

  const { nombre: nombrePlantilla, idioma, texto } = plantilla
  let resultado
  try {
    resultado = await enviarPlantillaPorKapso(numero, waId, nombrePlantilla, idioma, { nombre: nombreParaSaludo })
  } catch (err) {
    console.error(`[POST /api/contactos/${waId}/conversacion] error mandando plantilla:`, err)
    return NextResponse.json({ error: 'No se pudo mandar el mensaje de plantilla' }, { status: 502 })
  }

  // Se guarda el texto ya resuelto (con el nombre real en vez de {{nombre}}) para que se
  // vea como un mensaje normal en el hilo — no hay un componente separado para "renderizar"
  // una plantilla en la UI, y no hace falta uno para un solo body sin botones/medios.
  const textoResuelto = texto.replace('{{nombre}}', nombreParaSaludo)
  await agregarMensaje(conv.id, textoResuelto, 'outbound', undefined, {
    status: 'sent',
    waId: resultado.messages?.[0]?.id,
  })
  emitirEvento({ tipo: 'mensaje', numero: numeroId! })

  return NextResponse.json({ conversacionId: conv.id })
}
