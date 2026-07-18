// Tipo de mensaje compartido entre demo/standalone/GHL — incluye adjuntos multimedia.
export type TipoAdjunto = 'image' | 'audio' | 'document' | 'video'

export type Adjunto = {
  url: string
  tipo: TipoAdjunto
  nombre?: string
}

export type Mensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
}
