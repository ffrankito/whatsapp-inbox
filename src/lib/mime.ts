// Compartido entre el proxy de adjuntos (src/app/api/adjunto/proxy) y la descarga que
// persiste adjuntos entrantes en la base (src/lib/kapso/client.ts, descargarComoDataUrl)
// — los dos necesitan lo mismo: si Kapso no manda un Content-Type útil, inferirlo por la
// extensión del nombre de archivo para que el navegador sepa mostrarlo inline (si no,
// termina como "application/octet-stream" y el navegador lo trata como binario
// desconocido — fuerza descarga igual que si tuviera Content-Disposition: attachment).
const MIME_POR_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
}

export function inferirContentType(nombre: string | undefined, contentTypeDeOrigen: string | null | undefined): string {
  if (contentTypeDeOrigen && contentTypeDeOrigen !== 'application/octet-stream') return contentTypeDeOrigen
  const extension = nombre?.split('.').pop()?.toLowerCase()
  return (extension && MIME_POR_EXTENSION[extension]) || contentTypeDeOrigen || 'application/octet-stream'
}
