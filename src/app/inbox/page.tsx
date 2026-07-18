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
  const puedeEscribir = !!seleccionada && seleccionada.estado !== 'cerrada' && (!seleccionada.asignadaA || esMia)

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
                {archivoAdj && (
                  <div className="s24-adjunto-chip">
                    <span className="ico">{iconoParaMime(archivoAdj.type)}</span>
                    <span className="nombre">{archivoAdj.name}</span>
                    <span className="peso">{(archivoAdj.size / 1024).toFixed(0)} KB</span>
                    <button type="button" className="quitar" onClick={() => setArchivoAdj(null)} aria-label="Quitar archivo">×</button>
                  </div>
                )}
                <div className="s24-composer">
                  <label className="s24-attach" data-disabled={String(!puedeEscribir)}>
                    📎
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
                  <button className="s24-btn primary" onClick={enviar} disabled={!puedeEscribir || enviando || (!texto.trim() && !archivoAdj)}>
                    Enviar
                  </button>
                </div>
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
