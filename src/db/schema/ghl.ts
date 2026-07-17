import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const ghlInstalls = pgTable('ghl_installs', {
  locationId: text('location_id').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  creadoEn: timestamp('creado_en').defaultNow().notNull(),
  actualizadoEn: timestamp('actualizado_en').defaultNow().notNull(),
})

export type GhlInstall = typeof ghlInstalls.$inferSelect
export type GhlInstallNew = typeof ghlInstalls.$inferInsert
