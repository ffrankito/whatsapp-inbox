// Tipo de mensaje compartido entre demo/standalone/GHL — incluye adjuntos multimedia.
export type TipoAdjunto = 'image' | 'audio' | 'document' | 'video' | 'sticker'

export type Adjunto = {
  url: string
  tipo: TipoAdjunto
  nombre?: string
}

// Estado de entrega — solo aplica a mensajes 'outbound' (los que mandamos nosotros).
// 'sending' = todavía no confirmado por Kapso, 'sent'/'delivered'/'read'/'failed' llegan
// después vía webhook de estado de Kapso (ver ARCHITECTURE.md §19).
export type EstadoMensaje = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

export type Mensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
  status?: EstadoMensaje
  waId?: string
}
