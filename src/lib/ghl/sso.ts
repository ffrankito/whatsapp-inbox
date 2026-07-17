import CryptoJS from 'crypto-js'

export type GhlUserContext = {
  userId: string
  companyId: string
  role: string
  type: string
  userName: string
  email: string
  isAgencyOwner?: boolean
  activeLocation?: string
}

/**
 * Descifra el payload que el iframe recibe de GHL vía postMessage
 * (REQUEST_USER_DATA_RESPONSE). El Shared Secret es el generado en
 * Marketplace > (app) > Advanced Settings > Auth — distinto del Client Secret OAuth.
 */
export function decryptGhlUserContext(encryptedPayload: string): GhlUserContext {
  const sharedSecret = process.env.GHL_SHARED_SECRET_SSO
  if (!sharedSecret) throw new Error('GHL_SHARED_SECRET_SSO no configurado')

  const decrypted = CryptoJS.AES.decrypt(encryptedPayload, sharedSecret).toString(CryptoJS.enc.Utf8)
  if (!decrypted) throw new Error('No se pudo descifrar el payload SSO de GHL')

  return JSON.parse(decrypted) as GhlUserContext
}
