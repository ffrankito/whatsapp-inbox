'use client'

import { useEffect, useRef, useState } from 'react'
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

type Conversacion = {
  id: string
  contactId: string
  fullName?: string
  contactName?: string
  phone?: string
  lastMessageBody?: string
  unreadCount?: number
}

type Mensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
}

const POLL_MS = 5000

export default function InboxPage() {
  const [ssoListo, setSsoListo] = useState(false)
  const [numeroActivo, setNumeroActivo] = useState<NumeroId>('dealers')
  const [conversaciones, setConversaciones] = useState<Conversacion[]>([])
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null)
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [texto, setTexto] = useState('')
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)

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

  // ── Lista de conversaciones (poll) ────────────────────────────────────────
  useEffect(() => {
    if (!ssoListo) return

    let cancelado = false
    async function cargar() {
      try {
        const res = await fetch(`/api/conversaciones?numero=${numeroActivo}`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelado) setConversaciones(data.conversations ?? [])
      } catch {
        // silencioso: el próximo poll reintenta
      }
    }

    cargar()
    const interval = setInterval(cargar, POLL_MS)
    return () => {
      cancelado = true
      clearInterval(interval)
    }
  }, [ssoListo, numeroActivo])

  // ── Hilo de la conversación seleccionada (poll) ───────────────────────────
  useEffect(() => {
    if (!seleccionadaId) {
      setMensajes([])
      return
    }

    let cancelado = false
    async function cargar() {
      try {
        const res = await fetch(`/api/conversaciones/${seleccionadaId}`)
        if (!res.ok) return
        const data = await res.json()
        const lista: Mensaje[] = data?.messages?.messages ?? data?.messages ?? []
        if (!cancelado) setMensajes(lista)
      } catch {
        // silencioso: el próximo poll reintenta
      }
    }

    cargar()
    const interval = setInterval(cargar, POLL_MS)
    return () => {
      cancelado = true
      clearInterval(interval)
    }
  }, [seleccionadaId])

  const seleccionada = conversaciones.find((c) => c.id === seleccionadaId) ?? null

  async function responder() {
    if (!seleccionada || !texto.trim()) return
    setEnviando(true)
    try {
      await fetch(`/api/conversaciones/${seleccionada.id}/responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-s24-inbox': '1' },
        body: JSON.stringify({ contactId: seleccionada.contactId, numero: numeroActivo, message: texto }),
      })
      setTexto('')
    } finally {
      setEnviando(false)
    }
  }

  async function guardarNota() {
    if (!seleccionada || !nota.trim()) return
    await fetch(`/api/conversaciones/${seleccionada.id}/notas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-s24-inbox': '1' },
      body: JSON.stringify({ contactId: seleccionada.contactId, body: nota }),
    })
    setNota('')
  }

  return (
    <div className="s24-inbox">
      <div className="s24-app-top">
        <div className="s24-title">
          <span className="mark">💬</span>
          <div>
            <h1>Inbox WhatsApp</h1>
            <div className="sub">Área comercial · Security24</div>
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
                <span className="who">{c.fullName || c.contactName || c.phone || 'Sin nombre'}</span>
              </span>
              {c.lastMessageBody && <div className="preview">{c.lastMessageBody}</div>}
              {!!c.unreadCount && (
                <div className="chips">
                  <span className="s24-chip">{c.unreadCount} sin leer</span>
                </div>
              )}
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
                  <span className="name">{seleccionada.fullName || seleccionada.contactName || 'Sin nombre'}</span>
                  <span className="id">{seleccionada.phone}</span>
                </div>
              </div>

              <div className="s24-bubbles">
                {mensajes.map((m) => (
                  <div key={m.id} className={`s24-bubble ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                    {m.body}
                    <span className="t">{new Date(m.dateAdded).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>

              <div className="s24-composer">
                <input
                  type="text"
                  placeholder="Escribir una respuesta…"
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && responder()}
                />
                <button className="s24-btn primary" onClick={responder} disabled={enviando || !texto.trim()}>
                  Enviar
                </button>
              </div>

              <div className="s24-notes">
                <div className="head">
                  <span className="label">Nota / auditoría (queda en GHL)</span>
                </div>
                <textarea
                  placeholder="Agregar una nota a este contacto…"
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="s24-btn" onClick={guardarNota} disabled={!nota.trim()}>
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
