export type NumeroId = 'dealers' | 'abonados' | 'fullapp'

// `id` es el índice (1, 2, 3...) — estable mientras no se reordenen las env vars, se usa
// para que el frontend le diga al backend cuál de las plantillas rápidas apretó el
// agente sin tener que mandar el nombre completo de la plantilla de Meta.
export type PlantillaRapida = { id: string; etiqueta: string; nombre: string; idioma: string; texto: string }

export type NumeroWhatsapp = {
  id: NumeroId
  nombre: string
  phoneNumberId: string
  kapsoApiKey: string
  conversationProviderId: string
  // Plantillas HSM aprobadas por Meta para arrancar/reactivar conversaciones (ver
  // docs/BACKLOG.md #6) — hoy Full App tiene una sola, pero queda armado para sumar más
  // sin tocar código, solo agregando las env vars WA_<PREFIX>_TEMPLATE_<n>_*.
  plantillasRapidas: PlantillaRapida[]
}

function numero(id: NumeroId, nombre: string, envPrefix: string): NumeroWhatsapp {
  const plantillasRapidas: PlantillaRapida[] = []
  for (let i = 1; ; i++) {
    const plantillaNombre = process.env[`${envPrefix}_TEMPLATE_${i}_NOMBRE`]
    if (!plantillaNombre) break
    plantillasRapidas.push({
      id: String(i),
      etiqueta: process.env[`${envPrefix}_TEMPLATE_${i}_ETIQUETA`] ?? plantillaNombre,
      nombre: plantillaNombre,
      idioma: process.env[`${envPrefix}_TEMPLATE_${i}_IDIOMA`] ?? '',
      // `texto` es el cuerpo EXACTO aprobado (con el placeholder {{nombre}} tal cual lo
      // ve Meta) — se usa para guardar en nuestra base el mensaje ya resuelto, no hace
      // falta volver a pedírselo a Kapso.
      texto: process.env[`${envPrefix}_TEMPLATE_${i}_TEXTO`] ?? '',
    })
  }
  return {
    id,
    nombre,
    phoneNumberId: process.env[`${envPrefix}_PHONE_ID`] ?? '',
    kapsoApiKey: process.env[`${envPrefix}_API_KEY`] ?? '',
    conversationProviderId: process.env[`${envPrefix}_PROVIDER_ID`] ?? '',
    plantillasRapidas,
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
