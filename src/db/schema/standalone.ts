import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core'

// Persistencia real para STANDALONE_MODE (Fase 2) — antes vivía solo en memoria del
// proceso y se perdía en cada reinicio/redeploy. Se adelanta acá porque las pruebas en
// vivo lo necesitan, aunque el resto de la Fase 3 (tokens de instalación de GHL) todavía
// no arrancó. Se descarta en la Fase 6, cuando GHL pasa a ser la fuente de verdad.
export const conversacionesStandalone = pgTable('conversaciones_standalone', {
  id: text('id').primaryKey(),
  numero: text('numero').notNull(),
  contactId: text('contact_id').notNull(),
  phone: text('phone').notNull(),
  fullName: text('full_name').notNull(),
  estado: text('estado').notNull().default('sin_asignar'),
  asignadaAId: text('asignada_a_id'),
  asignadaANombre: text('asignada_a_nombre'),
  creadoEn: timestamp('creado_en').defaultNow().notNull(),
  actualizadoEn: timestamp('actualizado_en').defaultNow().notNull(),
})

export const mensajesStandalone = pgTable('mensajes_standalone', {
  id: text('id').primaryKey(),
  conversacionId: text('conversacion_id').notNull(),
  body: text('body').notNull(),
  direction: text('direction').notNull(),
  dateAdded: timestamp('date_added').defaultNow().notNull(),
  // Guardado como un solo campo jsonb en vez de columnas sueltas — es opcional, chico,
  // y no hace falta filtrar/indexar por sus campos internos.
  adjunto: jsonb('adjunto').$type<{ url: string; tipo: string; nombre?: string } | null>(),
  status: text('status'),
  waId: text('wa_id'),
})

export type ConversacionStandaloneRow = typeof conversacionesStandalone.$inferSelect
export type MensajeStandaloneRow = typeof mensajesStandalone.$inferSelect
