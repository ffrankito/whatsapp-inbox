import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { webhookLimitado } from '@/lib/rateLimit'

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

  // TODO: todavía no hay parser (equivalente a parseWebhook.ts de Kapso) — primero hay
  // que confirmar el shape real contra tráfico real (DM de prueba + comentario de
  // prueba), no adivinarlo. Por ahora solo se loguea para poder ver el payload real
  // apenas llegue el primer evento de verdad.
  console.log('[Instagram webhook] evento recibido:', JSON.stringify(payload))

  return NextResponse.json({ ok: true })
}
