import type { NextRequest } from 'next/server'

// Defensa simple contra CSRF: un sitio externo puede lograr que el navegador de un
// agente logueado mande un fetch/form a estas rutas usando su cookie de sesión (la
// cookie necesita SameSite=None para funcionar dentro del iframe de GHL, ver
// ARCHITECTURE.md §15) — pero no puede agregarle un header custom sin que el navegador
// dispare un preflight CORS, que nuestro server no autoriza para orígenes ajenos. Con
// que el frontend propio mande este header alcanza para bloquear ese ataque.
const HEADER = 'x-s24-inbox'

export function pedidoConfiable(request: NextRequest): boolean {
  return request.headers.get(HEADER) === '1'
}
