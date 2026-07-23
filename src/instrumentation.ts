// Corre una sola vez al arrancar el proceso, antes de aceptar cualquier pedido (hook
// oficial de Next.js — https://nextjs.org/docs/app/guides/instrumentation). Se agrega
// después de un bug real: faltaba SESSION_SECRET en Railway y el server arrancó
// "bien" igual, pero cualquier login con Google tiraba un 500 sin explicación hasta que
// alguien lo probaba a mano. Con esto, si falta algo, el proceso ni siquiera levanta —
// se ve clarito en los logs de deploy, no en medio de una prueba en vivo.
export async function register() {
  // Los routers de edge/otros runtimes no tienen las env vars de Node ni hace falta
  // repetir esto ahí — alcanza con validar una sola vez, en el runtime de Node.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const DEMO_MODE = process.env.DEMO_MODE === 'true'
  const STANDALONE_MODE = !DEMO_MODE && process.env.STANDALONE_MODE === 'true'

  const faltantes: string[] = []
  function requerir(nombre: string) {
    if (!process.env[nombre]?.trim()) faltantes.push(nombre)
  }

  // Login con Google: siempre hace falta, en cualquier modo (agenteActual() lo usa
  // siempre, ver src/lib/agente.ts).
  requerir('SESSION_SECRET')
  requerir('NEXT_PUBLIC_GOOGLE_CLIENT_ID')
  requerir('GOOGLE_ALLOWED_DOMAIN')

  if (STANDALONE_MODE) {
    requerir('DATABASE_URL')
    requerir('KAPSO_APP_SECRET')
    requerir('MINIO_ENDPOINT')
    requerir('MINIO_ACCESS_KEY')
    requerir('MINIO_SECRET_KEY')

    // Al menos un número tiene que estar configurado del todo — si no, no hay con qué
    // número hablar. No se exige que estén los 3: es normal ir conectando de a uno.
    const prefijos = ['WA_DEALERS', 'WA_ABONADOS', 'WA_FULLAPP']
    const configurados = prefijos.filter((p) => process.env[`${p}_PHONE_ID`]?.trim() && process.env[`${p}_API_KEY`]?.trim())
    if (configurados.length === 0) {
      faltantes.push('WA_DEALERS_PHONE_ID/API_KEY (o WA_ABONADOS_*/WA_FULLAPP_*) — ningún número tiene Phone ID + API Key configurados')
    }
    // Configuración a medias (uno de los dos cargado, el otro no) es peor que ninguno —
    // ese número parece andar pero todos los envíos van a fallar en silencio.
    for (const p of prefijos) {
      const tienePhoneId = !!process.env[`${p}_PHONE_ID`]?.trim()
      const tieneApiKey = !!process.env[`${p}_API_KEY`]?.trim()
      if (tienePhoneId !== tieneApiKey) {
        faltantes.push(`${p}_PHONE_ID/API_KEY están a medias (uno cargado, el otro no)`)
      }
    }
  } else if (!DEMO_MODE) {
    // Modo real con GHL (Fase 6+) — todavía no se usa en producción, pero si algún día
    // se despliega así, más vale que falle acá y no en medio del OAuth de un cliente.
    requerir('GHL_CLIENT_ID')
    requerir('GHL_CLIENT_SECRET')
    requerir('GHL_SHARED_SECRET_SSO')
    requerir('GHL_REDIRECT_URI')
    requerir('GHL_LOCATION_ID')
    requerir('DATABASE_URL')
  }

  if (faltantes.length > 0) {
    throw new Error(
      `Faltan variables de entorno — el server no puede arrancar así:\n` +
        faltantes.map((f) => `  - ${f}`).join('\n'),
    )
  }
}
