export type NumeroId = 'dealers' | 'abonados' | 'fullapp'

export type PlantillaReabrir = { nombre: string; idioma: string; texto: string }

export type NumeroWhatsapp = {
  id: NumeroId
  nombre: string
  phoneNumberId: string
  kapsoApiKey: string
  conversationProviderId: string
  // Solo está definida para los números que ya tienen una plantilla HSM aprobada por
  // Meta para arrancar conversaciones nuevas (ver docs/BACKLOG.md #6) — hoy solo Full
  // App. `texto` es el cuerpo EXACTO aprobado (con el placeholder {{nombre}} tal cual lo
  // ve Meta) — se usa para guardar en nuestra base el mensaje ya resuelto, no hace falta
  // volver a pedírselo a Kapso.
  plantillaReabrir?: PlantillaReabrir
}

function numero(id: NumeroId, nombre: string, envPrefix: string): NumeroWhatsapp {
  const plantillaNombre = process.env[`${envPrefix}_TEMPLATE_REABRIR`]
  const plantillaIdioma = process.env[`${envPrefix}_TEMPLATE_REABRIR_IDIOMA`]
  const plantillaTexto = process.env[`${envPrefix}_TEMPLATE_REABRIR_TEXTO`]
  return {
    id,
    nombre,
    phoneNumberId: process.env[`${envPrefix}_PHONE_ID`] ?? '',
    kapsoApiKey: process.env[`${envPrefix}_API_KEY`] ?? '',
    conversationProviderId: process.env[`${envPrefix}_PROVIDER_ID`] ?? '',
    plantillaReabrir:
      plantillaNombre && plantillaIdioma && plantillaTexto
        ? { nombre: plantillaNombre, idioma: plantillaIdioma, texto: plantillaTexto }
        : undefined,
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
