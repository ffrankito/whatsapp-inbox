export type NumeroId = 'dealers' | 'abonados' | 'fullapp'

export type NumeroWhatsapp = {
  id: NumeroId
  nombre: string
  phoneNumberId: string
  kapsoApiKey: string
  conversationProviderId: string
}

function numero(id: NumeroId, nombre: string, envPrefix: string): NumeroWhatsapp {
  return {
    id,
    nombre,
    phoneNumberId: process.env[`${envPrefix}_PHONE_ID`] ?? '',
    kapsoApiKey: process.env[`${envPrefix}_API_KEY`] ?? '',
    conversationProviderId: process.env[`${envPrefix}_PROVIDER_ID`] ?? '',
  }
}

export const NUMEROS: Record<NumeroId, NumeroWhatsapp> = {
  dealers: numero('dealers', 'Dealers', 'WA_DEALERS'),
  abonados: numero('abonados', 'Abonados', 'WA_ABONADOS'),
  fullapp: numero('fullapp', 'Full App', 'WA_FULLAPP'),
}

export function numeroPorPhoneId(phoneNumberId: string): NumeroWhatsapp | undefined {
  return Object.values(NUMEROS).find((n) => n.phoneNumberId === phoneNumberId)
}

export function numeroPorProviderId(conversationProviderId: string): NumeroWhatsapp | undefined {
  return Object.values(NUMEROS).find((n) => n.conversationProviderId === conversationProviderId)
}
