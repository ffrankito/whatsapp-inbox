import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { webhookLimitado } from '@/lib/rateLimit'
import { parsearMensajeEntrante } from '@/lib/instagram/parseWebhook'

// Instagram, directo contra Meta (no pasa por Kapso, ver docs/BACKLOG.md). Mismo criterio
// de seguridad que el webhook de Kapso: firma HMAC verificada antes de confiar en nada
// del body. La diferencia con Kapso es el handshake inicial GET (Meta lo exige para
// activar la suscripción del webhook — no tiene equivalente en Kapso).

// Meta llama a esto UNA vez al guardar la URL en el panel, para confirmar que el
// callback es de verdad nuestro antes de empezar a mandar eventos reales.
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('hub.mode')
  const token = request.nextUrl.searchParams.get('hub.verify_token')
  const challenge = request.nextUrl.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && challenge && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    // Meta espera el challenge tal cual, como texto plano — no como JSON.
    return new NextResponse(challenge, { status: 200 })
  }

  console.error('[Instagram webhook] verificación fallida (mode/token no coinciden)')
  return NextResponse.json({ error: 'verification failed' }, { status: 403 })
}

export async function POST(request: NextRequest) {
  if (webhookLimitado(request, 'instagram-webhook')) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 })
  }

  const body = await request.text()
  const signature = request.headers.get('x-hub-signature-256') ?? ''
  const expected = `sha256=${createHmac('sha256', process.env.INSTAGRAM_APP_SECRET!).update(body).digest('hex')}`

  const sigOk =
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))
  if (!sigOk) {
    console.error('[Instagram webhook] firma inválida')
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ ok: true })
  }

  const entrante = parsearMensajeEntrante(payload)
  if (entrante) {
    console.log('[Instagram webhook] mensaje parseado:', entrante)
    // TODO: todavía no hay dónde guardarlo — falta el equivalente de
    // standalone/store.ts para Instagram (tabla propia, agenda, UI). Por ahora solo se
    // confirma que el parser funciona bien contra el shape real.
  } else {
    // No es un mensaje de texto reconocido (podría ser un comentario, una reacción, un
    // adjunto — shapes todavía no confirmados contra tráfico real) — se loguea entero
    // para poder ir confirmando cada caso nuevo a medida que aparezca.
    console.log('[Instagram webhook] evento sin parsear (revisar shape):', JSON.stringify(payload))
  }

  return NextResponse.json({ ok: true })
}
