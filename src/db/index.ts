import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Lazy: este módulo lo importa (transitivamente) cualquier ruta que toque
// standalone/store.ts, incluso en DEMO_MODE donde nunca se llega a usar `db` de
// verdad — si `postgres(...)` se llamara al cargar el módulo, faltando DATABASE_URL
// (como en DEMO_MODE) rompería el import entero, no solo el uso real.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function db() {
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error('Falta DATABASE_URL — no se puede usar la base de datos')
    }
    _db = drizzle(postgres(process.env.DATABASE_URL), { schema })
  }
  return _db
}
