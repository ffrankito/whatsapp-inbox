import { verify } from 'crypto'

// Clave pública fija publicada por GHL para verificar sus webhooks (Ed25519).
// https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide
const GHL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`

export function verificarFirmaGhl(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || signatureHeader === 'N/A') return false
  try {
    const payloadBuffer = Buffer.from(rawBody, 'utf8')
    const signatureBuffer = Buffer.from(signatureHeader, 'base64')
    return verify(null, payloadBuffer, GHL_PUBLIC_KEY, signatureBuffer)
  } catch {
    return false
  }
}
