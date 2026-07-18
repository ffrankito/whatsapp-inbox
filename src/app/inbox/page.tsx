'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import './inbox.css'

// NOTA: los nombres de campo de GHL (ConversationSchema / GetMessageResponseDto) están
// tomados del spec OpenAPI oficial pero todavía no se verificaron contra una respuesta
// real — hacerlo en el primer test end-to-end (ver ARCHITECTURE.md §10).

type NumeroId = 'dealers' | 'abonados' | 'fullcontrol'

const NUMEROS: { id: NumeroId; nombre: string }[] = [
  { id: 'dealers', nombre: 'Dealers' },
  { id: 'abonados', nombre: 'Abonados' },
  { id: 'fullcontrol', nombre: 'App Full Control' },
]

type Agente = { id: string; nombre: string }
type EstadoConversacion = 'sin_asignar' | 'asignada' | 'cerrada'
type TipoAdjunto = 'image' | 'audio' | 'document' | 'video'
type Adjunto = { url: string; tipo: TipoAdjunto; nombre?: string }
type EstadoMensaje = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

type Conversacion = {
  id: string
  contactId: string
  fullName?: string
  contactName?: string
  phone?: string
  lastMessageBody?: string
  unreadCount?: number
  estado?: EstadoConversacion
  asignadaA?: Agente
}

type Mensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
  status?: EstadoMensaje
}

// Tiempo real vía SSE (/api/eventos) — este poll es solo red de seguridad por si se
// corta la conexión SSE (reinicio del contenedor, deploy). Ver ARCHITECTURE.md §5.1.
const POLL_RESPALDO_MS = 45_000
const AGENTE_STORAGE_KEY = 's24_agente'

function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '?'
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return (partes[0][0] + partes[1][0]).toUpperCase()
}

function iconoParaMime(mime: string): string {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.startsWith('video/')) return '🎬'
  return '📄'
}

export default function InboxPage() {
  const [ssoListo, setSsoListo] = useState(false)
  const [numeroActivo, setNumeroActivo] = useState<NumeroId>('dealers')
  const [conversaciones, setConversaciones] = useState<Conversacion[]>([])
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null)
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [texto, setTexto] = useState('')
  const [archivoAdj, setArchivoAdj] = useState<File | null>(null)
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const ultimoTypingRef = useRef(0)

  // ── Grabar y mandar audio (paridad con Huellas de Paz) ───────────────────
  const [grabando, setGrabando] = useState(false)
  const [tiempoGrab, setTiempoGrab] = useState(0)
  const [errorMic, setErrorMic] = useState<string | null>(null)
  const [micDenegado, setMicDenegado] = useState(false)
  const [prePromptMic, setPrePromptMic] = useState(false)
  type ContextoGrabacion = {
    stream: MediaStream
    audioCtx: AudioContext
    source: MediaStreamAudioSourceNode
    proc: ScriptProcessorNode
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enc: any
    chunks: Int8Array[]
  }
  const grabacionRef = useRef<ContextoGrabacion | null>(null)
  const grabTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Identidad del agente (solo hace falta mientras no haya SSO de GHL —
  // ver ARCHITECTURE.md, "Asignación / bloqueo entre agentes") ─────────────
  const [agente, setAgente] = useState<Agente | null>(null)
  const [nombreInput, setNombreInput] = useState('')

  useEffect(() => {
    try {
      const guardado = localStorage.getItem(AGENTE_STORAGE_KEY)
      if (guardado) setAgente(JSON.parse(guardado))
    } catch {
      // localStorage no disponible o corrupto — se vuelve a pedir el nombre
    }
  }, [])

  function confirmarAgente() {
    const nombre = nombreInput.trim()
    if (!nombre) return
    const nuevo: Agente = { id: crypto.randomUUID(), nombre }
    localStorage.setItem(AGENTE_STORAGE_KEY, JSON.stringify(nuevo))
    setAgente(nuevo)
  }

  function headersConAgente(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      'x-s24-inbox': '1',
      ...(agente ? { 'x-s24-agente-id': agente.id, 'x-s24-agente-nombre': agente.nombre } : {}),
    }
  }

  // ── Handshake SSO con GHL (iframe del Custom Menu Link) ──────────────────
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.message !== 'REQUEST_USER_DATA_RESPONSE') return
      const encryptedPayload = event.data?.payload
      if (!encryptedPayload) return

      fetch('/api/ghl/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedPayload }),
      })
        .then((res) => setSsoListo(res.ok))
        .catch(() => setSsoListo(false))
    }

    window.addEventListener('message', onMessage)
    window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*')

    // Fuera del iframe (dev local) esto nunca responde — no bloquea la carga de datos,
    // /api/conversaciones cae al GHL_LOCATION_ID del .env como respaldo (ver lib/auth.ts).
    const fallback = setTimeout(() => setSsoListo(true), 1500)

    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(fallback)
    }
  }, [])

  // Refs para que el listener de SSE (montado una sola vez) siempre lea el número/
  // conversación actuales sin tener que reabrir la conexión en cada cambio.
  const numeroActivoRef = useRef(numeroActivo)
  const seleccionadaIdRef = useRef(seleccionadaId)
  useEffect(() => {
    numeroActivoRef.current = numeroActivo
  }, [numeroActivo])
  useEffect(() => {
    seleccionadaIdRef.current = seleccionadaId
  }, [seleccionadaId])

  const cargarConversaciones = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversaciones?numero=${numeroActivoRef.current}`)
      if (!res.ok) return
      const data = await res.json()
      setConversaciones(data.conversations ?? [])
    } catch {
      // silencioso: el próximo evento/poll de respaldo reintenta
    }
  }, [])

  const cargarMensajes = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversaciones/${id}`)
      if (!res.ok) return
      const data = await res.json()
      const lista: Mensaje[] = data?.messages?.messages ?? data?.messages ?? []
      setMensajes(lista)
    } catch {
      // silencioso: el próximo evento/poll de respaldo reintenta
    }
  }, [])

  // ── Lista de conversaciones: carga inicial + poll de respaldo lento ──────
  useEffect(() => {
    if (!ssoListo) return
    cargarConversaciones()
    const interval = setInterval(cargarConversaciones, POLL_RESPALDO_MS)
    return () => clearInterval(interval)
  }, [ssoListo, numeroActivo, cargarConversaciones])

  // ── Hilo de la conversación seleccionada: carga inicial + poll de respaldo ─
  useEffect(() => {
    setTexto('')
    setArchivoAdj(null)
    if (!seleccionadaId) {
      setMensajes([])
      return
    }
    cargarMensajes(seleccionadaId)
    const interval = setInterval(() => cargarMensajes(seleccionadaId), POLL_RESPALDO_MS)
    return () => clearInterval(interval)
  }, [seleccionadaId, cargarMensajes])

  // ── Tiempo real: una sola conexión SSE, reacciona a eventos del número activo ─
  useEffect(() => {
    if (!ssoListo) return

    const es = new EventSource('/api/eventos')
    es.onmessage = (event) => {
      try {
        const evento = JSON.parse(event.data)
        if (evento?.numero !== numeroActivoRef.current) return
        cargarConversaciones()
        if (seleccionadaIdRef.current) cargarMensajes(seleccionadaIdRef.current)
      } catch {
        // evento no parseable (ej. el ping), se ignora
      }
    }

    return () => es.close()
  }, [ssoListo, cargarConversaciones, cargarMensajes])

  const seleccionada = conversaciones.find((c) => c.id === seleccionadaId) ?? null
  const esMia = !!seleccionada && !!agente && seleccionada.asignadaA?.id === agente.id
  // Hay que tomar la conversación antes de poder responder — no alcanza con que esté
  // libre (antes dejaba responder a cualquiera mientras nadie más la hubiera tomado).
  const puedeEscribir = !!seleccionada && seleccionada.estado === 'asignada' && esMia

  async function refrescarTodo() {
    await cargarConversaciones()
    if (seleccionadaIdRef.current) await cargarMensajes(seleccionadaIdRef.current)
  }

  async function responder() {
    if (!seleccionada || !texto.trim()) return
    setEnviando(true)
    try {
      await fetch(`/api/conversaciones/${seleccionada.id}/responder`, {
        method: 'POST',
        headers: headersConAgente({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ contactId: seleccionada.contactId, numero: numeroActivo, message: texto }),
      })
      setTexto('')
      await cargarMensajes(seleccionada.id)
    } finally {
      setEnviando(false)
    }
  }

  // Igual que WhatsApp: el archivo se sube con un texto opcional a modo de "caption" en
  // el mismo mensaje, no como dos mensajes separados.
  async function subirArchivo(file: File, caption: string) {
    if (!seleccionada) return
    const form = new FormData()
    form.append('archivo', file)
    form.append('numero', numeroActivo)
    form.append('contactId', seleccionada.contactId)
    if (caption.trim()) form.append('caption', caption.trim())
    setEnviando(true)
    try {
      await fetch(`/api/conversaciones/${seleccionada.id}/adjunto`, {
        method: 'POST',
        headers: headersConAgente(),
        body: form,
      })
      setTexto('')
      setArchivoAdj(null)
      await cargarMensajes(seleccionada.id)
    } finally {
      setEnviando(false)
    }
  }

  async function enviar() {
    if (archivoAdj) {
      await subirArchivo(archivoAdj, texto)
    } else if (texto.trim()) {
      await responder()
    }
  }

  // Avisa por WhatsApp que estamos escribiendo (se ve en el celular del contacto, no acá
  // — WhatsApp Business no informa al negocio cuándo el CLIENTE está escribiendo, solo al
  // revés). Throttleado a como mucho una vez cada 20s, igual que Huellas de Paz — el
  // indicador dura unos 25s en el celular del contacto.
  function avisarEscribiendo() {
    if (!seleccionada) return
    const ahora = Date.now()
    if (ahora - ultimoTypingRef.current < 20_000) return
    ultimoTypingRef.current = ahora
    fetch(`/api/conversaciones/${seleccionada.id}/typing`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ numero: numeroActivo }),
    }).catch(() => {})
  }

  // WhatsApp rechaza el audio fragmentado que produce MediaRecorder (webm/mp4
  // fragmentado) — hay que armar un MP3 estándar a mano con Web Audio API + lamejs, igual
  // que hace Huellas de Paz.
  async function iniciarGrabacion() {
    setPrePromptMic(false)
    setMicDenegado(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const { Mp3Encoder } = await import('@breezystack/lamejs')
      const audioCtx = new AudioContext({ sampleRate: 44100 })
      const source = audioCtx.createMediaStreamSource(stream)
      const proc = audioCtx.createScriptProcessor(8192, 1, 1)
      const enc = new Mp3Encoder(1, 44100, 128)
      const chunks: Int8Array[] = []

      proc.onaudioprocess = (e: AudioProcessingEvent) => {
        const pcmFloat = e.inputBuffer.getChannelData(0)
        const pcm16 = new Int16Array(pcmFloat.length)
        for (let i = 0; i < pcmFloat.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(pcmFloat[i] * 32767)))
        }
        const encoded = enc.encodeBuffer(pcm16)
        if (encoded.length > 0) chunks.push(new Int8Array(encoded))
      }

      source.connect(proc)
      proc.connect(audioCtx.destination)
      grabacionRef.current = { stream, audioCtx, source, proc, enc, chunks }
      setGrabando(true)
      setTiempoGrab(0)
      grabTimerRef.current = setInterval(() => setTiempoGrab((t) => t + 1), 1000)
    } catch (err: unknown) {
      const nombre = err instanceof DOMException ? err.name : ''
      const bloqueado = nombre === 'NotAllowedError' || nombre === 'PermissionDeniedError'
      const noEncontrado = nombre === 'NotFoundError' || nombre === 'DevicesNotFoundError'
      setMicDenegado(bloqueado || noEncontrado)
      setPrePromptMic(true)
      setErrorMic(noEncontrado ? 'No se encontró micrófono en este dispositivo.' : null)
    }
  }

  function detenerYEnviarGrabacion() {
    if (grabTimerRef.current) clearInterval(grabTimerRef.current)
    const ctx = grabacionRef.current
    if (!ctx) return
    ctx.source.disconnect()
    ctx.proc.disconnect()
    ctx.stream.getTracks().forEach((t) => t.stop())
    ctx.audioCtx.close()
    const final = ctx.enc.flush()
    if (final.length > 0) ctx.chunks.push(new Int8Array(final))
    const blob = new Blob(ctx.chunks as unknown as BlobPart[], { type: 'audio/mpeg' })
    grabacionRef.current = null
    setGrabando(false)
    setTiempoGrab(0)
    const archivo = new File([blob], `audio-${Date.now()}.mp3`, { type: 'audio/mpeg' })
    subirArchivo(archivo, '')
  }

  function cancelarGrabacion() {
    if (grabTimerRef.current) clearInterval(grabTimerRef.current)
    const ctx = grabacionRef.current
    if (ctx) {
      ctx.source.disconnect()
      ctx.proc.disconnect()
      ctx.stream.getTracks().forEach((t) => t.stop())
      ctx.audioCtx.close()
      grabacionRef.current = null
    }
    setGrabando(false)
    setTiempoGrab(0)
  }

  function formatearTiempoGrab(seg: number): string {
    return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`
  }

  async function guardarNota() {
    if (!seleccionada || !nota.trim()) return
    await fetch(`/api/conversaciones/${seleccionada.id}/notas`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ contactId: seleccionada.contactId, body: nota }),
    })
    setNota('')
  }

  async function tomar() {
    if (!seleccionada) return
    await fetch(`/api/conversaciones/${seleccionada.id}/asignar`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: '{}',
    })
    await refrescarTodo()
  }

  async function liberar() {
    if (!seleccionada) return
    await fetch(`/api/conversaciones/${seleccionada.id}/liberar`, { method: 'POST', headers: headersConAgente() })
    await refrescarTodo()
  }

  async function cerrar() {
    if (!seleccionada) return
    await fetch(`/api/conversaciones/${seleccionada.id}/cerrar`, { method: 'POST', headers: headersConAgente() })
    await refrescarTodo()
  }

  // ── Gate: pedir nombre antes de mostrar el inbox (identidad para el bloqueo) ─
  if (!agente) {
    return (
      <div className="s24-inbox">
        <div className="s24-agente-gate">
          <div className="s24-agente-card">
            <img className="mark" src="/logos24.jpg" alt="Security24" />
            <h1>¿Quién sos?</h1>
            <p>Se usa para saber quién tiene tomada cada conversación.</p>
            <input
              type="text"
              placeholder="Tu nombre"
              value={nombreInput}
              onChange={(e) => setNombreInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmarAgente()}
              autoFocus
            />
            <button className="s24-btn primary" onClick={confirmarAgente} disabled={!nombreInput.trim()}>
              Entrar
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="s24-inbox">
      <div className="s24-app-top">
        <div className="s24-title">
          <img className="mark" src="/logos24.jpg" alt="Security24" />
          <div>
            <h1>Inbox WhatsApp</h1>
            <div className="sub">Área comercial · Security24 · {agente.nombre}</div>
          </div>
        </div>
        <div className="s24-channel-status">
          {NUMEROS.map((n) => (
            <span key={n.id} className="s24-status-pill">
              <span className="led" />
              {n.nombre}
            </span>
          ))}
        </div>
      </div>

      <div className="s24-console">
        <nav className="s24-numbers">
          <div className="eyebrow">Números</div>
          {NUMEROS.map((n) => (
            <button
              key={n.id}
              className="s24-num-btn"
              data-active={String(n.id === numeroActivo)}
              onClick={() => {
                setNumeroActivo(n.id)
                setSeleccionadaId(null)
              }}
            >
              <span className="row1">
                <span className="name">{n.nombre}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="s24-convlist">
          <div className="listhead">
            {NUMEROS.find((n) => n.id === numeroActivo)?.nombre} · {conversaciones.length}
          </div>
          {conversaciones.length === 0 && <div className="empty">Sin conversaciones todavía.</div>}
          {conversaciones.map((c) => (
            <button
              key={c.id}
              className="s24-conv-item"
              data-active={String(c.id === seleccionadaId)}
              onClick={() => setSeleccionadaId(c.id)}
            >
              <span className="row1">
                <span className="s24-avatar">{iniciales(c.fullName || c.contactName || c.phone || '?')}</span>
                <span className="who">{c.fullName || c.contactName || c.phone || 'Sin nombre'}</span>
              </span>
              {c.lastMessageBody && <div className="preview">{c.lastMessageBody}</div>}
              <div className="chips">
                {!!c.unreadCount && <span className="s24-chip">{c.unreadCount} sin leer</span>}
                {c.estado === 'asignada' && <span className="s24-chip lock">🔒 {c.asignadaA?.nombre}</span>}
                {c.estado === 'cerrada' && <span className="s24-chip closed">Cerrada</span>}
              </div>
            </button>
          ))}
        </div>

        <section className="s24-thread">
          {!seleccionada ? (
            <div className="s24-thread-empty">Elegí una conversación para ver el hilo</div>
          ) : (
            <>
              <div className="s24-thread-head">
                <div className="who">
                  <span className="s24-avatar lg">{iniciales(seleccionada.fullName || seleccionada.contactName || seleccionada.phone || '?')}</span>
                  <span className="who-text">
                    <span className="name">{seleccionada.fullName || seleccionada.contactName || 'Sin nombre'}</span>
                    <span className="id">{seleccionada.phone}</span>
                  </span>
                </div>
                <div className="thread-actions">
                  {(!seleccionada.estado || seleccionada.estado === 'sin_asignar') && (
                    <button className="s24-btn primary" onClick={tomar}>Tomar</button>
                  )}
                  {esMia && seleccionada.estado === 'asignada' && (
                    <>
                      <button className="s24-btn" onClick={liberar}>Liberar</button>
                      <button className="s24-btn" onClick={cerrar}>Cerrar</button>
                    </>
                  )}
                </div>
              </div>

              {(!seleccionada.estado || seleccionada.estado === 'sin_asignar') && (
                <div className="s24-lock-banner">Tomá esta conversación para poder responder.</div>
              )}
              {!puedeEscribir && seleccionada.estado === 'asignada' && !esMia && (
                <div className="s24-lock-banner">🔒 Esta conversación la tiene tomada <b>{seleccionada.asignadaA?.nombre}</b> — no podés responder hasta que la libere.</div>
              )}
              {seleccionada.estado === 'cerrada' && (
                <div className="s24-lock-banner">Esta conversación está cerrada.</div>
              )}

              <div className="s24-bubbles">
                {mensajes.map((m) => (
                  <div key={m.id} className={`s24-bubble ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                    {m.adjunto && <Adjunto adjunto={m.adjunto} />}
                    {m.body && <span className="s24-bubble-text">{m.body}</span>}
                    <span className="t">
                      {new Date(m.dateAdded).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                      {m.direction === 'outbound' && <Tick status={m.status} />}
                    </span>
                  </div>
                ))}
              </div>

              <div className="s24-composer-wrap">
                {prePromptMic && (
                  <div className="s24-mic-prompt" data-denegado={String(micDenegado)}>
                    <span className="ico">{micDenegado ? <IconoCandado /> : <IconoMic />}</span>
                    <p>
                      {micDenegado
                        ? errorMic ?? 'Micrófono bloqueado. Habilitalo desde el ícono de candado de la barra de direcciones y recargá la página.'
                        : 'Para grabar un audio necesitamos acceso al micrófono.'}
                    </p>
                    {!micDenegado && (
                      <button type="button" className="s24-btn primary" onClick={iniciarGrabacion}>Permitir</button>
                    )}
                    <button type="button" className="cerrar" onClick={() => { setPrePromptMic(false); setMicDenegado(false) }} aria-label="Cerrar aviso"><IconoX small /></button>
                  </div>
                )}

                {grabando ? (
                  <div className="s24-composer s24-recording">
                    <button type="button" className="s24-attach" title="Cancelar" onClick={cancelarGrabacion}><IconoX /></button>
                    <div className="s24-recording-indicator">
                      <span className="dot" />
                      <span className="tiempo">{formatearTiempoGrab(tiempoGrab)}</span>
                      <span className="label">Grabando…</span>
                    </div>
                    <button type="button" className="s24-btn primary round" title="Detener y enviar" onClick={detenerYEnviarGrabacion}><IconoEnviar /></button>
                  </div>
                ) : (
                  <>
                    {archivoAdj && (
                      <div className="s24-adjunto-chip">
                        <span className="ico">{iconoParaMime(archivoAdj.type)}</span>
                        <span className="nombre">{archivoAdj.name}</span>
                        <span className="peso">{(archivoAdj.size / 1024).toFixed(0)} KB</span>
                        <button type="button" className="quitar" onClick={() => setArchivoAdj(null)} aria-label="Quitar archivo"><IconoX small /></button>
                      </div>
                    )}
                    <div className="s24-composer">
                      <label className="s24-attach" data-disabled={String(!puedeEscribir)}>
                        <IconoClip />
                        <input
                          type="file"
                          hidden
                          disabled={!puedeEscribir}
                          onChange={(e) => {
                            const file = e.target.files?.[0]
                            if (file) setArchivoAdj(file)
                            e.target.value = ''
                          }}
                        />
                      </label>
                      <input
                        type="text"
                        placeholder={
                          archivoAdj ? 'Agregar un mensaje (opcional)…' : puedeEscribir ? 'Escribir una respuesta…' : 'Tomá la conversación para responder'
                        }
                        value={texto}
                        disabled={!puedeEscribir}
                        onChange={(e) => {
                          setTexto(e.target.value)
                          if (e.target.value) avisarEscribiendo()
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && enviar()}
                      />
                      {texto.trim() || archivoAdj ? (
                        <button className="s24-btn primary round" onClick={enviar} disabled={!puedeEscribir || enviando} title="Enviar">
                          <IconoEnviar />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="s24-attach"
                          title="Grabar audio"
                          disabled={!puedeEscribir}
                          onClick={iniciarGrabacion}
                        >
                          <IconoMic />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="s24-notes">
                <div className="head">
                  <span className="label">Nota / auditoría (queda en GHL)</span>
                </div>
                <textarea
                  placeholder="Agregar una nota a este contacto…"
                  value={nota}
                  disabled={!puedeEscribir}
                  onChange={(e) => setNota(e.target.value)}
                />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="s24-btn" onClick={guardarNota} disabled={!puedeEscribir || !nota.trim()}>
                    Guardar nota
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

// Íconos de línea (mismo criterio que Huellas de Paz) en vez de emoji — el render de
// emoji varía muchísimo entre sistemas operativos/fuentes y queda inconsistente con el
// resto del diseño.
function IconoClip() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function IconoMic() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function IconoEnviar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function IconoX({ small }: { small?: boolean }) {
  const s = small ? 12 : 14
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconoCandado() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

// Mismo criterio que Huellas de Paz: tildes de texto plano (no SVG), coloreadas según el
// estado que llega por el webhook de estado de Kapso. Ver ARCHITECTURE.md §19.
function Tick({ status }: { status?: EstadoMensaje }) {
  if (status === 'read') return <span className="s24-tick read" title="Leído">✓✓</span>
  if (status === 'delivered') return <span className="s24-tick" title="Entregado">✓✓</span>
  if (status === 'failed') return <span className="s24-tick failed" title="Error al enviar">✗</span>
  if (status === 'sending') return <span className="s24-tick" title="Enviando…">🕓</span>
  return <span className="s24-tick" title="Enviado">✓</span>
}

function Adjunto({ adjunto }: { adjunto: Adjunto }) {
  if (adjunto.tipo === 'image') {
    return <img className="s24-adjunto-img" src={adjunto.url} alt={adjunto.nombre || 'Imagen'} />
  }
  if (adjunto.tipo === 'video') {
    return <video className="s24-adjunto-img" src={adjunto.url} controls />
  }
  if (adjunto.tipo === 'audio') {
    return <audio className="s24-adjunto-audio" src={adjunto.url} controls />
  }
  return (
    <a className="s24-adjunto-doc" href={adjunto.url} target="_blank" rel="noreferrer" download={adjunto.nombre}>
      📄 <span>{adjunto.nombre || 'Descargar documento'}</span>
    </a>
  )
}
