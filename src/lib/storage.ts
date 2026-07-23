import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'

// Storage de objetos propio (MinIO en Railway, self-hosted — ver docs/BACKLOG.md #19)
// para los adjuntos (fotos/audios/documentos/videos), en vez de guardarlos en base64
// adentro de la misma tabla de mensajes de Postgres. El bucket es PRIVADO a propósito
// (son fotos/documentos de clientes de una empresa de seguridad, no algo para dejar con
// un link público abierto a cualquiera) — se sirve siempre a través de
// /api/adjunto/proxy, que ya exige que quien lo pida sea un agente identificado.
//
// El endpoint usado (MINIO_ENDPOINT) es la red PRIVADA de Railway
// (http://bucket.railway.internal:9000) — solo alcanzable entre servicios del mismo
// proyecto de Railway, nunca desde afuera ni desde una máquina local. No hay forma de
// probar esto en desarrollo local, solo funciona una vez desplegado.

const BUCKET = process.env.MINIO_BUCKET ?? 's24-wppinbox-adjuntos'

// Prefijo propio para distinguir "esto vive en nuestro storage" de una URL real de Kapso
// (http/https) o de una `data:` URL vieja (mensajes de antes de este cambio, que se
// siguen sirviendo directo, ver Adjunto() en page.tsx) — nunca es una URL real, es solo
// una referencia interna que /api/adjunto/proxy sabe interpretar.
export const PREFIJO_STORAGE = 's24storage://'

function esquemaStorage(key: string): string {
  return `${PREFIJO_STORAGE}${key}`
}

function claveDesdeUrl(url: string): string | null {
  return url.startsWith(PREFIJO_STORAGE) ? url.slice(PREFIJO_STORAGE.length) : null
}

function cliente(): S3Client {
  const endpoint = process.env.MINIO_ENDPOINT
  const accessKeyId = process.env.MINIO_ACCESS_KEY
  const secretAccessKey = process.env.MINIO_SECRET_KEY
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Falta configurar MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY')
  }
  return new S3Client({
    endpoint,
    region: 'us-east-1', // MinIO no tiene regiones de verdad, el SDK igual lo pide — cualquier valor sirve
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // obligatorio para MinIO (y la mayoría de los S3-compatibles que no son AWS)
  })
}

let bucketAsegurado = false
async function asegurarBucket(s3: S3Client): Promise<void> {
  if (bucketAsegurado) return
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
  }
  bucketAsegurado = true
}

// Sube un archivo y devuelve la referencia interna (no una URL real) para guardar en
// `adjunto.url` — nunca se expone el bucket/las credenciales al frontend.
export async function subirArchivo(buffer: Buffer, contentType: string, nombreOriginal?: string): Promise<string> {
  const extension = nombreOriginal?.includes('.') ? '.' + nombreOriginal.split('.').pop() : ''
  const key = `${randomUUID()}${extension}`
  const s3 = cliente()
  await asegurarBucket(s3)
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }))
  return esquemaStorage(key)
}

export type ArchivoDescargado = { body: Readable; contentType?: string; contentLength?: number }

// Devuelve null tanto si `url` no es una referencia de nuestro storage como si falla la
// descarga — el caller (el proxy) no necesita distinguir los dos casos, en ambos
// corresponde un 404/502 genérico.
export async function descargarArchivo(url: string): Promise<ArchivoDescargado | null> {
  const key = claveDesdeUrl(url)
  if (!key) return null

  const s3 = cliente()
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    if (!res.Body) return null
    return {
      body: res.Body as Readable,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
    }
  } catch {
    return null
  }
}

export function esReferenciaStorage(url: string): boolean {
  return url.startsWith(PREFIJO_STORAGE)
}
