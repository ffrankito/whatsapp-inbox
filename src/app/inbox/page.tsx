'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Script from 'next/script'
import EmojiPicker, { Theme, type EmojiClickData } from 'emoji-picker-react'
import './inbox.css'

// NOTA: los nombres de campo de GHL (ConversationSchema / GetMessageResponseDto) están
// tomados del spec OpenAPI oficial pero todavía no se verificaron contra una respuesta
// real — hacerlo en el primer test end-to-end (ver ARCHITECTURE.md §10).

type NumeroId = 'dealers' | 'abonados' | 'fullapp'

// Cada número tiene su propia identidad visual (color + ícono) — son 3 líneas de
// negocio distintas (dealers/abonados/app), no una lista de filtros genérica, así que
// cambiar de número tiene que sentirse como cambiar de área.
const NUMEROS: { id: NumeroId; nombre: string; Icono: () => React.JSX.Element }[] = [
  { id: 'dealers', nombre: 'Dealers', Icono: IconoDealers },
  { id: 'abonados', nombre: 'Abonados', Icono: IconoAbonados },
  { id: 'fullapp', nombre: 'Full App', Icono: IconoApp },
]

type Agente = { id: string; nombre: string }
type EstadoConversacion = 'sin_asignar' | 'asignada' | 'cerrada'
type TipoAdjunto = 'image' | 'audio' | 'document' | 'video' | 'sticker'
type Adjunto = { url: string; tipo: TipoAdjunto; nombre?: string }
type EstadoMensaje = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

type Conversacion = {
  id: string
  contactId: string
  fullName?: string
  contactName?: string
  phone?: string
  lastMessageBody?: string
  lastMessageId?: string
  lastMessageAdjuntoTipo?: TipoAdjunto
  unreadCount?: number
  estado?: EstadoConversacion
  asignadaA?: Agente
  vistoHastaMensajeId?: string
}

type Mensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
  status?: EstadoMensaje
  reaccion?: string
}

// Tipado mínimo del SDK de Google Identity Services (no hay @types oficial) — solo lo
// que se usa acá, para no tener que tirar de `any` en el resto del componente.
type GoogleCredentialResponse = { credential: string }
type GoogleAccountsId = {
  initialize: (config: { client_id: string; callback: (resp: GoogleCredentialResponse) => void }) => void
  renderButton: (
    parent: HTMLElement,
    options: { theme?: string; size?: string; text?: string; shape?: string; width?: number },
  ) => void
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } }
  }
}

// Tiempo real vía SSE (/api/eventos) — este poll es solo red de seguridad por si se
// corta la conexión SSE (reinicio del contenedor, deploy). Ver ARCHITECTURE.md §5.1.
const POLL_RESPALDO_MS = 45_000

function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '?'
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return (partes[0][0] + partes[1][0]).toUpperCase()
}

// Comparaciones "livianas" para no re-renderizar la lista/hilo cuando el poll trae
// exactamente lo mismo que ya había — solo miran los campos que afectan lo que se ve.
function conversacionesIguales(a: Conversacion[], b: Conversacion[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  // Tiene que comparar TODO lo que se muestra en la lista — si falta un campo acá, ese
  // cambio se queda sin reflejarse hasta que cambie algún otro (ej: el nombre real de un
  // contacto que llega después del primer mensaje, ver encontrarOCrearConversacion).
  return a.every((c, i) => {
    const d = b[i]
    return (
      c.id === d.id &&
      c.fullName === d.fullName &&
      c.contactName === d.contactName &&
      c.phone === d.phone &&
      c.lastMessageId === d.lastMessageId &&
      c.lastMessageBody === d.lastMessageBody &&
      c.lastMessageAdjuntoTipo === d.lastMessageAdjuntoTipo &&
      c.estado === d.estado &&
      c.asignadaA?.id === d.asignadaA?.id &&
      c.asignadaA?.nombre === d.asignadaA?.nombre &&
      c.vistoHastaMensajeId === d.vistoHastaMensajeId
    )
  })
}

function mensajesIguales(a: Mensaje[], b: Mensaje[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((m, i) => {
    const n = b[i]
    return m.id === n.id && m.status === n.status && m.reaccion === n.reaccion
  })
}

function iconoParaMime(mime: string): string {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime.startsWith('video/')) return '🎬'
  return '📄'
}

// El backend guarda "[Imagen]"/"[Audio]"/etc. como texto cuando el adjunto no tiene
// caption (ver parsearMensajeEntrante) — no queremos mostrar eso tal cual, ni en la
// lista ni en la burbuja, sino un ícono + etiqueta como WhatsApp real.
function esPlaceholderAdjunto(body?: string): boolean {
  return !!body && /^\[[^[\]]+\]$/.test(body.trim())
}

function iconoYEtiquetaAdjunto(tipo: TipoAdjunto): { icono: string; etiqueta: string } {
  switch (tipo) {
    case 'image': return { icono: '📷', etiqueta: 'Foto' }
    case 'video': return { icono: '🎥', etiqueta: 'Video' }
    case 'audio': return { icono: '🎤', etiqueta: 'Audio' }
    case 'sticker': return { icono: '😀', etiqueta: 'Sticker' }
    default: return { icono: '📄', etiqueta: 'Documento' }
  }
}

export default function InboxPage() {
  const [ssoListo, setSsoListo] = useState(false)
  const [numeroActivo, setNumeroActivo] = useState<NumeroId>('dealers')
  // Un casillero por número, no un solo valor compartido — cada respuesta de
  // /api/conversaciones escribe únicamente en el casillero del número que pidió, así que
  // una respuesta tardía de un número que ya no está activo nunca puede pisar los datos
  // recién cargados de otro número, sin importar en qué orden lleguen las respuestas.
  const [conversacionesPorNumero, setConversacionesPorNumero] = useState<Partial<Record<NumeroId, Conversacion[]>>>({})
  const conversaciones = useMemo(
    () => conversacionesPorNumero[numeroActivo] ?? [],
    [conversacionesPorNumero, numeroActivo],
  )
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null)
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [texto, setTexto] = useState('')
  const [archivoAdj, setArchivoAdj] = useState<File | null>(null)
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [agentesConocidos, setAgentesConocidos] = useState<Agente[]>([])
  const [filtroAgenteId, setFiltroAgenteId] = useState('')
  const [imagenAmpliada, setImagenAmpliada] = useState<string | null>(null)
  // Agenda de contactos (Kapso) del número activo — vista alternativa a la lista de
  // conversaciones, no un panel aparte, para no romper el layout de 3 columnas ya armado.
  const [vistaAgenda, setVistaAgenda] = useState(false)
  // Bump para que la Agenda se refresque sola cuando llega un evento SSE del número
  // activo (mensaje nuevo) — ver el useEffect de "Tiempo real" más abajo.
  const [agendaRefreshTick, setAgendaRefreshTick] = useState(0)
  // Picker de emoji compartido — uno solo a la vez, se renderiza como panel fijo (no
  // pegado a cada burbuja) para no depender de la posición dentro de .s24-bubbles, que
  // hace scroll y lo cortaba/desalineaba. Sirve tanto para reaccionar a un mensaje como
  // para insertar un emoji en el composer.
  const [pickerEmoji, setPickerEmoji] = useState<{ modo: 'reaccion'; mensajeId: string } | { modo: 'composer' } | null>(null)

  function onSeleccionarEmoji(data: EmojiClickData) {
    if (pickerEmoji?.modo === 'reaccion') {
      const actual = mensajes.find((m) => m.id === pickerEmoji.mensajeId)?.reaccion
      reaccionar(pickerEmoji.mensajeId, actual === data.emoji ? '' : data.emoji)
    } else if (pickerEmoji?.modo === 'composer') {
      setTexto((prev) => prev + data.emoji)
    }
    setPickerEmoji(null)
  }
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

  // ── Identidad del agente vía login con Google (temporal hasta el SSO de GHL en la
  // Fase 6 — ver docs/BACKLOG.md #1). `cargandoAgente` evita mostrar el botón de login
  // por un instante antes de confirmar si ya había una sesión (cookie) válida.
  const [agente, setAgente] = useState<Agente | null>(null)
  const [cargandoAgente, setCargandoAgente] = useState(true)
  const [googleScriptListo, setGoogleScriptListo] = useState(false)
  const googleBtnRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!imagenAmpliada) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setImagenAmpliada(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [imagenAmpliada])

  // Restaura la sesión desde la cookie (si había un login de Google válido) al cargar
  // la página — reemplaza el localStorage de antes, ahora la identidad es server-side.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setAgente(data.agente ?? null))
      .catch(() => setAgente(null))
      .finally(() => setCargandoAgente(false))
  }, [])

  const manejarCredencialGoogle = useCallback((resp: GoogleCredentialResponse) => {
    fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-s24-inbox': '1' },
      body: JSON.stringify({ credential: resp.credential }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setAgente(data.agente))
      .catch(() => {
        // Token rechazado (fuera del dominio permitido, expirado, etc.) — se queda en
        // la pantalla de login, Google ya le muestra su propio error si corresponde.
      })
  }, [])

  // Renderiza el botón de Google apenas están listos tanto el script del SDK como la
  // confirmación de que no había sesión previa — si se hace antes de tiempo, el botón
  // parpadea un instante antes de la pantalla principal.
  useEffect(() => {
    if (!googleScriptListo || cargandoAgente || agente || !googleBtnRef.current) return
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
    if (!clientId || !window.google) return
    window.google.accounts.id.initialize({ client_id: clientId, callback: manejarCredencialGoogle })
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      theme: 'filled_blue',
      size: 'large',
      shape: 'pill',
      text: 'signin_with',
      width: 280,
    })
  }, [googleScriptListo, cargandoAgente, agente, manejarCredencialGoogle])

  function cerrarSesion() {
    fetch('/api/auth/logout', { method: 'POST', headers: { 'x-s24-inbox': '1' } }).finally(() => setAgente(null))
  }

  const headersConAgente = useCallback(
    (extra: Record<string, string> = {}): Record<string, string> => ({
      ...extra,
      'x-s24-inbox': '1',
    }),
    [],
  )

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
  const conversacionesRef = useRef<Conversacion[]>([])
  useEffect(() => {
    numeroActivoRef.current = numeroActivo
  }, [numeroActivo])
  useEffect(() => {
    conversacionesRef.current = conversaciones
  }, [conversaciones])
  useEffect(() => {
    seleccionadaIdRef.current = seleccionadaId
  }, [seleccionadaId])

  // "No leída" es una propiedad de la conversación en sí (vistoHastaMensajeId, en el
  // servidor), no de quién la mira — así cualquier agente/dispositivo que la abra la
  // marca como leída para todos, en vez de cada navegador tener su propia versión (era
  // localStorage antes, ver docs/ARCHITECTURE.md §26).
  function noLeida(c: Conversacion): boolean {
    return !!c.lastMessageId && c.vistoHastaMensajeId !== c.lastMessageId
  }

  const cargarConversaciones = useCallback(async () => {
    const numeroPedido = numeroActivoRef.current
    try {
      const res = await fetch(`/api/conversaciones?numero=${numeroPedido}`)
      if (!res.ok) return
      const data = await res.json()
      const nuevas: Conversacion[] = data.conversations ?? []
      // Evita re-renderizar todo el árbol (lista + hilo) cuando el poll trae exactamente
      // lo mismo que ya teníamos para ese número — que es la mayoría de las veces.
      setConversacionesPorNumero((prev) =>
        conversacionesIguales(prev[numeroPedido] ?? [], nuevas)
          ? prev
          : { ...prev, [numeroPedido]: nuevas },
      )
    } catch {
      // silencioso: el próximo evento/poll de respaldo reintenta
    }
  }, [])

  const marcarVista = useCallback(
    (id: string, lastMessageId: string | undefined) => {
      if (!lastMessageId) return
      fetch(`/api/conversaciones/${id}/visto`, {
        method: 'POST',
        headers: headersConAgente({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mensajeId: lastMessageId }),
      })
        .then(() => cargarConversaciones())
        .catch(() => {
          // silencioso: si falla, sigue apareciendo "sin leer" y se reintenta al volver a abrirla
        })
    },
    [headersConAgente, cargarConversaciones],
  )

  // Agentes conocidos (para el selector de "Traspasar a…") — llamar a esta ruta también
  // nos registra a nosotros mismos como destino posible para los demás (ver ARCHITECTURE.md §20).
  const cargarAgentes = useCallback(async () => {
    try {
      const res = await fetch('/api/agentes', { headers: headersConAgente() })
      if (!res.ok) return
      const data = await res.json()
      setAgentesConocidos(data.agentes ?? [])
    } catch {
      // silencioso: el próximo poll reintenta
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agente])

  const cargarMensajes = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversaciones/${id}`)
      if (!res.ok) return
      const data = await res.json()
      const lista: Mensaje[] = data?.messages?.messages ?? data?.messages ?? []
      // Mismo criterio que en cargarConversaciones: no re-renderizar el hilo si el poll
      // trajo exactamente los mismos mensajes con el mismo estado de tilde.
      setMensajes((prev) => (mensajesIguales(prev, lista) ? prev : lista))
    } catch {
      // silencioso: el próximo evento/poll de respaldo reintenta
    }
  }, [])

  // Reaccionar (o sacar la reacción, si ya tenía puesto el mismo emoji — ver el toggle
  // en el onEmojiClick del picker) a un mensaje del hilo activo.
  async function reaccionar(mensajeId: string, emoji: string) {
    if (!seleccionadaId) return
    try {
      await fetch(`/api/conversaciones/${seleccionadaId}/reaccion`, {
        method: 'POST',
        headers: headersConAgente({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mensajeId, emoji }),
      })
      await cargarMensajes(seleccionadaId)
    } catch {
      // silencioso: si falla, la reacción no queda puesta y se puede reintentar
    }
  }

  // ── Lista de conversaciones: carga inicial + poll de respaldo lento ──────
  useEffect(() => {
    if (!ssoListo) return
    cargarConversaciones()
    const interval = setInterval(cargarConversaciones, POLL_RESPALDO_MS)
    return () => clearInterval(interval)
  }, [ssoListo, numeroActivo, cargarConversaciones])

  // ── Agentes conocidos: carga inicial + poll de respaldo lento ────────────
  useEffect(() => {
    if (!ssoListo) return
    // Fetch inicial + polling de datos externos, no hay forma de derivarlo del render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarAgentes()
    const interval = setInterval(cargarAgentes, POLL_RESPALDO_MS)
    return () => clearInterval(interval)
  }, [ssoListo, cargarAgentes])

  // ── Hilo de la conversación seleccionada: carga inicial + poll de respaldo ─
  useEffect(() => {
    // Reset intencional del borrador al cambiar de conversación (si no, un archivo
    // cargado para un contacto podría terminar mandándose a otro).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTexto('')
    setArchivoAdj(null)
    if (!seleccionadaId) {
      setMensajes([])
      return
    }
    cargarMensajes(seleccionadaId)
    marcarVista(seleccionadaId, conversacionesRef.current.find((c) => c.id === seleccionadaId)?.lastMessageId)
    // Aviso de cortesía al cliente (tilde azul) al abrir la conversación — separado del
    // "escribiendo…" (eso solo se manda cuando el agente tipea, ver avisarEscribiendo).
    fetch(`/api/conversaciones/${seleccionadaId}/marcar-leido`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ numero: numeroActivoRef.current }),
    }).catch(() => {})
    const interval = setInterval(() => cargarMensajes(seleccionadaId), POLL_RESPALDO_MS)
    return () => clearInterval(interval)
  }, [seleccionadaId, cargarMensajes, headersConAgente, marcarVista])

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
        // La agenda de contactos también reacciona a mensajes nuevos del número activo
        // (un contacto nuevo se agrega solo a la agenda de Kapso apenas escribe) — ver
        // el prop refreshSignal en <Agenda>.
        setAgendaRefreshTick((t) => t + 1)
      } catch {
        // evento no parseable (ej. el ping), se ignora
      }
    }

    return () => es.close()
  }, [ssoListo, cargarConversaciones, cargarMensajes])

  const seleccionada = conversaciones.find((c) => c.id === seleccionadaId) ?? null
  const conversacionesFiltradas = filtroAgenteId
    ? conversaciones.filter((c) => c.asignadaA?.id === filtroAgenteId)
    : conversaciones
  const esMia = !!seleccionada && !!agente && seleccionada.asignadaA?.id === agente.id
  // Hay que tomar la conversación antes de poder responder — no alcanza con que esté
  // libre (antes dejaba responder a cualquiera mientras nadie más la hubiera tomado).
  const puedeEscribir = !!seleccionada && seleccionada.estado === 'asignada' && esMia

  // Abre un documento (PDF/DOCX/etc.) en una pestaña nueva, pasando por nuestro proxy en
  // vez de linkear directo a la URL de Kapso — así se abre inline en el visor nativo del
  // navegador en vez de forzar "Guardar como" (ver /api/adjunto/proxy). Se abre la
  // pestaña en blanco de forma síncrona (dentro del click) y recién después se le carga
  // la URL real — si se abriera recién cuando responde el fetch, el navegador lo trata
  // como popup no solicitado y lo bloquea.
  function abrirDocumento(mensajeId: string) {
    if (!seleccionada) return
    const ventana = window.open('', '_blank')
    fetch(`/api/adjunto/proxy?conversacionId=${seleccionada.id}&mensajeId=${mensajeId}`, {
      headers: headersConAgente(),
    })
      .then((res) => {
        if (!res.ok) throw new Error('proxy falló')
        return res.blob()
      })
      .then((blob) => {
        if (ventana) ventana.location.href = URL.createObjectURL(blob)
      })
      .catch(() => ventana?.close())
  }

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
    // Date.now() acá es para el nombre del archivo, dentro de un handler de click, no
    // durante el render — el linter lo marca igual por ser un closure del componente.
    // eslint-disable-next-line react-hooks/purity
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

  async function traspasar(destino: Agente) {
    if (!seleccionada) return
    await fetch(`/api/conversaciones/${seleccionada.id}/traspasar`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agenteId: destino.id, agenteNombre: destino.nombre }),
    })
    await refrescarTodo()
  }

  // ── Gate: login con Google antes de mostrar el inbox (identidad para el bloqueo
  // entre agentes; temporal hasta el SSO de GHL en la Fase 6 — ver docs/BACKLOG.md #1) ──
  if (cargandoAgente) {
    // Se espera la confirmación de /api/auth/me antes de mostrar nada — si no, el botón
    // de login parpadearía un instante aunque ya hubiera una sesión válida.
    return (
      <div className="s24-inbox">
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setGoogleScriptListo(true)} />
      </div>
    )
  }

  if (!agente) {
    return (
      <div className="s24-inbox">
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setGoogleScriptListo(true)} />
        <div className="s24-agente-gate">
          <div className="s24-agente-card">
            <img className="mark" src="/logos24.jpg" alt="Security24" />
            <h1>Inbox WhatsApp</h1>
            <p>Iniciá sesión con tu cuenta de Security24 para continuar.</p>
            <div className="s24-google-btn" ref={googleBtnRef} />
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
        <div className="s24-top-right">
          <div className="s24-channel-status">
            {NUMEROS.map((n) => (
              <span key={n.id} className="s24-status-pill" data-numero={n.id}>
                <span className="led" />
                {n.nombre}
              </span>
            ))}
          </div>
          <button type="button" className="s24-logout" onClick={cerrarSesion}>Cerrar sesión</button>
        </div>
      </div>

      <div className="s24-console" data-numero={numeroActivo}>
        <nav className="s24-numbers">
          <div className="eyebrow">Números</div>
          {NUMEROS.map((n) => (
            <button
              key={n.id}
              className="s24-num-btn"
              data-numero={n.id}
              data-active={String(n.id === numeroActivo)}
              onClick={() => {
                if (n.id === numeroActivo) return
                setNumeroActivo(n.id)
                setSeleccionadaId(null)
              }}
            >
              <span className="row1">
                <span className="s24-num-ico"><n.Icono /></span>
                <span className="name">{n.nombre}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="s24-convlist">
          <div className="s24-convlist-tabs">
            <button type="button" className="s24-tab" data-active={String(!vistaAgenda)} onClick={() => setVistaAgenda(false)}>
              Chats
            </button>
            <button type="button" className="s24-tab" data-active={String(vistaAgenda)} onClick={() => setVistaAgenda(true)}>
              Agenda
            </button>
          </div>

          {vistaAgenda ? (
            <Agenda
              numero={numeroActivo}
              headersConAgente={headersConAgente}
              refreshSignal={agendaRefreshTick}
              onAbrirConversacion={(id) => {
                setFiltroAgenteId('')
                setSeleccionadaId(id)
                setVistaAgenda(false)
              }}
            />
          ) : (
            <>
              <div className="listhead">
                {NUMEROS.find((n) => n.id === numeroActivo)?.nombre} · {conversacionesFiltradas.length}
                {filtroAgenteId && ` (de ${agentesConocidos.find((a) => a.id === filtroAgenteId)?.nombre ?? '…'})`}
              </div>
              {agentesConocidos.length > 0 && (
                <select
                  className="s24-agente-filtro"
                  value={filtroAgenteId}
                  onChange={(e) => setFiltroAgenteId(e.target.value)}
                  title="Ver solo las conversaciones tomadas por un agente"
                >
                  <option value="">Todos los agentes</option>
                  {agentesConocidos.map((a) => (
                    <option key={a.id} value={a.id}>{a.nombre}{a.id === agente.id ? ' (vos)' : ''}</option>
                  ))}
                </select>
              )}
              {conversacionesFiltradas.length === 0 && (
                <div className="empty">
                  {filtroAgenteId ? 'Ese agente no tiene conversaciones tomadas en este número.' : 'Sin conversaciones todavía.'}
                </div>
              )}
              {conversacionesFiltradas.map((c) => (
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
                  {c.lastMessageAdjuntoTipo ? (
                    <div className="preview">
                      {iconoYEtiquetaAdjunto(c.lastMessageAdjuntoTipo).icono}{' '}
                      {esPlaceholderAdjunto(c.lastMessageBody) ? iconoYEtiquetaAdjunto(c.lastMessageAdjuntoTipo).etiqueta : c.lastMessageBody}
                    </div>
                  ) : (
                    c.lastMessageBody && <div className="preview">{c.lastMessageBody}</div>
                  )}
                  <div className="chips">
                    {noLeida(c) && <span className="s24-chip unread">Sin leer</span>}
                    {c.estado === 'asignada' && <span className="s24-chip lock">🔒 {c.asignadaA?.nombre}</span>}
                    {c.estado === 'cerrada' && <span className="s24-chip closed">Cerrada</span>}
                  </div>
                </button>
              ))}
            </>
          )}
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
                      {agentesConocidos.filter((a) => a.id !== agente.id).length > 0 && (
                        <select
                          className="s24-btn s24-traspasar"
                          value=""
                          onChange={(e) => {
                            const destino = agentesConocidos.find((a) => a.id === e.target.value)
                            if (destino) traspasar(destino)
                          }}
                        >
                          <option value="" disabled>Traspasar a…</option>
                          {agentesConocidos.filter((a) => a.id !== agente.id).map((a) => (
                            <option key={a.id} value={a.id}>{a.nombre}</option>
                          ))}
                        </select>
                      )}
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
                {mensajes.map((m) => {
                  const esMediaVisual = m.adjunto?.tipo === 'image' || m.adjunto?.tipo === 'video' || m.adjunto?.tipo === 'sticker'
                  // Si el adjunto no tenía caption, el body es solo el placeholder "[Imagen]"/etc
                  // que ya armamos nosotros — no tiene sentido mostrarlo como si fuera texto del
                  // mensaje, la imagen/audio/documento ya se está mostrando arriba.
                  const caption = m.adjunto && esPlaceholderAdjunto(m.body) ? undefined : m.body
                  const horaTick = (
                    <>
                      {new Date(m.dateAdded).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                      {m.direction === 'outbound' && <Tick status={m.status} />}
                    </>
                  )
                  return (
                    <div key={m.id} className="s24-bubble-row" data-direction={m.direction}>
                      <div
                        className={`s24-bubble ${m.direction === 'inbound' ? 'in' : 'out'}`}
                        data-media={String(!!esMediaVisual)}
                      >
                        {m.adjunto && <Adjunto adjunto={m.adjunto} onAmpliar={setImagenAmpliada} mensajeId={m.id} onAbrirDocumento={abrirDocumento} />}
                        {esMediaVisual && !caption && <span className="t sobre-media">{horaTick}</span>}
                        {caption && <span className="s24-bubble-text">{caption}</span>}
                        {!(esMediaVisual && !caption) && <span className="t">{horaTick}</span>}
                        {m.reaccion && <span className="s24-reaccion-badge">{m.reaccion}</span>}
                      </div>
                      {puedeEscribir && (
                        <button
                          type="button"
                          className="s24-reaccionar-btn"
                          onClick={() =>
                            setPickerEmoji(
                              pickerEmoji?.modo === 'reaccion' && pickerEmoji.mensajeId === m.id
                                ? null
                                : { modo: 'reaccion', mensajeId: m.id },
                            )
                          }
                          title="Reaccionar"
                        >
                          🙂
                        </button>
                      )}
                    </div>
                  )
                })}
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
                      <button
                        type="button"
                        className="s24-attach"
                        title="Insertar emoji"
                        disabled={!puedeEscribir}
                        onClick={() => setPickerEmoji(pickerEmoji?.modo === 'composer' ? null : { modo: 'composer' })}
                      >
                        🙂
                      </button>
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

              {pickerEmoji && (
                <div className="s24-emoji-overlay">
                  <div className="s24-emoji-overlay-head">
                    <span>{pickerEmoji.modo === 'reaccion' ? 'Reaccionar' : 'Insertar emoji'}</span>
                    <button type="button" className="cerrar" onClick={() => setPickerEmoji(null)} aria-label="Cerrar">✕</button>
                  </div>
                  <EmojiPicker onEmojiClick={onSeleccionarEmoji} theme={Theme.AUTO} width="100%" height={340} />
                </div>
              )}

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

      {imagenAmpliada && (
        <div className="s24-lightbox" onClick={() => setImagenAmpliada(null)}>
          <button type="button" className="s24-lightbox-cerrar" onClick={() => setImagenAmpliada(null)} aria-label="Cerrar">
            <IconoX />
          </button>
          <img src={imagenAmpliada} alt="Imagen ampliada" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
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

// Un ícono por número — refuerza que son 3 áreas distintas, no un mismo canal filtrado.
function IconoDealers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  )
}

function IconoAbonados() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 3.5v5.2c0 5-3.4 8.9-8 10.3-4.6-1.4-8-5.3-8-10.3V5.5L12 2z" />
    </svg>
  )
}

function IconoApp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <line x1="10" y1="19" x2="14" y2="19" />
    </svg>
  )
}

type ContactoAgenda = { id: string; waId: string; profileName?: string; customerId?: string }

// Agenda de contactos de Kapso para el número activo — ver, buscar y corregir el
// nombre, y abrir la conversación de los que ya tienen una (ver /api/contactos y
// /api/contactos/[waId]/conversacion). Iniciar conversación nueva con un contacto que
// nunca escribió queda afuera (requiere mensaje de plantilla, ver docs/BACKLOG.md).
function Agenda({
  numero,
  headersConAgente,
  refreshSignal,
  onAbrirConversacion,
}: {
  numero: NumeroId
  headersConAgente: (extra?: Record<string, string>) => Record<string, string>
  refreshSignal: number
  onAbrirConversacion: (conversacionId: string) => void
}) {
  const [contactos, setContactos] = useState<ContactoAgenda[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(false)
  const [editandoWaId, setEditandoWaId] = useState<string | null>(null)
  const [nombreEdit, setNombreEdit] = useState('')
  const [abriendoWaId, setAbriendoWaId] = useState<string | null>(null)
  const [sinConversacionWaId, setSinConversacionWaId] = useState<string | null>(null)
  // waId de contactos que aparecieron por primera vez desde que se abrió la agenda de
  // este número (para marcarlos "Nuevo") — se arma comparando contra la carga anterior,
  // nunca contra la primerísima carga (si no, todos arrancarían marcados como nuevos).
  const [nuevosWaIds, setNuevosWaIds] = useState<Set<string>>(new Set())
  const vistosRef = useRef<Set<string>>(new Set())
  const primeraCargaRef = useRef(true)

  // A prueba de carreras, no de timing (mismo criterio que el cambio de número de
  // conversaciones): guarda cuál es el número "vigente" para poder ignorar una
  // respuesta tardía de un número que ya no es el activo, en vez de confiar en que
  // las respuestas lleguen en el mismo orden en que se pidieron.
  const numeroRef = useRef(numero)
  const prevNumeroRef = useRef(numero)
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    numeroRef.current = numero
  }, [numero])

  const cargarContactos = useCallback(
    (numeroPedido: NumeroId, busquedaPedida: string) => {
      setCargando(true)
      setError(false)
      const params = new URLSearchParams({ numero: numeroPedido })
      if (busquedaPedida.trim()) params.set('q', busquedaPedida.trim())
      fetch(`/api/contactos?${params.toString()}`, { headers: headersConAgente() })
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((data) => {
          if (numeroRef.current !== numeroPedido) return
          const lista: ContactoAgenda[] = data.contactos ?? []
          if (primeraCargaRef.current) {
            // Primera carga de este número: se toma como línea de base, nadie arranca
            // marcado como "nuevo".
            vistosRef.current = new Set(lista.map((c) => c.waId))
            primeraCargaRef.current = false
          } else {
            const nuevos = lista.filter((c) => !vistosRef.current.has(c.waId)).map((c) => c.waId)
            if (nuevos.length > 0) {
              setNuevosWaIds((prev) => new Set([...prev, ...nuevos]))
              nuevos.forEach((id) => vistosRef.current.add(id))
            }
          }
          setContactos(lista)
        })
        .catch(() => {
          if (numeroRef.current === numeroPedido) setError(true)
        })
        .finally(() => {
          if (numeroRef.current === numeroPedido) setCargando(false)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    const numeroCambio = prevNumeroRef.current !== numero
    prevNumeroRef.current = numero

    if (numeroCambio) {
      // Cambiar de número no es "tipear" — se limpia y recarga al toque, sin esperar
      // el debounce (si no, se ve la agenda vieja un instante, que es justo el bug).
      // También reinicia la línea de base de "nuevo" — es por número, no global.
      setContactos([])
      setNuevosWaIds(new Set())
      vistosRef.current = new Set()
      primeraCargaRef.current = true
      if (busqueda) setBusqueda('')
      cargarContactos(numero, '')
      return
    }

    const t = setTimeout(() => cargarContactos(numero, busqueda), 250)
    return () => clearTimeout(t)
  }, [numero, busqueda, cargarContactos])

  // Refresco en tiempo real: cuando llega un mensaje del número activo (mismo evento
  // SSE que usa el chat), la agenda se recarga sola — un contacto nuevo se agrega solo
  // al directorio de Kapso apenas escribe, así que reaparece acá sin que nadie recargue
  // la página. Sin debounce: no es "tipear", es un evento puntual.
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    cargarContactos(numero, busqueda)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  function descartarNuevo(waId: string) {
    setNuevosWaIds((prev) => {
      if (!prev.has(waId)) return prev
      const next = new Set(prev)
      next.delete(waId)
      return next
    })
  }

  function empezarEdicion(c: ContactoAgenda) {
    setEditandoWaId(c.waId)
    setNombreEdit(c.profileName ?? '')
  }

  function guardarEdicion(waId: string) {
    const nombre = nombreEdit.trim()
    if (!nombre) return
    fetch(`/api/contactos/${encodeURIComponent(waId)}?numero=${numero}`, {
      method: 'PATCH',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ profileName: nombre }),
    })
      .then((res) => (res.ok ? cargarContactos(numero, busqueda) : undefined))
      .finally(() => setEditandoWaId(null))
  }

  function abrirConversacion(waId: string) {
    setAbriendoWaId(waId)
    setSinConversacionWaId(null)
    fetch(`/api/contactos/${encodeURIComponent(waId)}/conversacion?numero=${numero}`, { headers: headersConAgente() })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (data.conversacionId) {
          onAbrirConversacion(data.conversacionId)
        } else {
          setSinConversacionWaId(waId)
        }
      })
      .catch(() => setSinConversacionWaId(waId))
      .finally(() => setAbriendoWaId(null))
  }

  return (
    <div className="s24-agenda">
      <input
        className="s24-agenda-buscador"
        type="text"
        placeholder="Buscar por nombre o teléfono…"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
      />
      {cargando && <div className="empty">Cargando contactos…</div>}
      {!cargando && error && <div className="empty">No se pudo cargar la agenda.</div>}
      {!cargando && !error && contactos.length === 0 && <div className="empty">Sin contactos todavía.</div>}
      {!cargando && !error && contactos.map((c) => (
        <div
          key={c.id}
          className="s24-agenda-item"
          onClick={() => nuevosWaIds.has(c.waId) && descartarNuevo(c.waId)}
        >
          <span className="s24-avatar">{iniciales(c.profileName || c.waId)}</span>
          <div className="s24-agenda-info">
            {nuevosWaIds.has(c.waId) && <span className="s24-chip unread">Nuevo</span>}
            {editandoWaId === c.waId ? (
              <input
                className="s24-agenda-nombre-input"
                type="text"
                value={nombreEdit}
                autoFocus
                onChange={(e) => setNombreEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') guardarEdicion(c.waId)
                  if (e.key === 'Escape') setEditandoWaId(null)
                }}
                onBlur={() => guardarEdicion(c.waId)}
              />
            ) : (
              <span className="who">{c.profileName || 'Sin nombre'}</span>
            )}
            <span className="s24-agenda-tel">{c.waId}</span>
          </div>
          <div className="s24-agenda-acciones">
            {editandoWaId !== c.waId && (
              <button type="button" className="s24-agenda-btn" onClick={() => empezarEdicion(c)} title="Editar nombre">
                ✏️
              </button>
            )}
            {sinConversacionWaId === c.waId ? (
              <span className="s24-agenda-sin-conv">Sin conversación todavía</span>
            ) : (
              <button
                type="button"
                className="s24-agenda-btn"
                onClick={() => abrirConversacion(c.waId)}
                disabled={abriendoWaId === c.waId}
                title="Abrir conversación"
              >
                {abriendoWaId === c.waId ? '…' : '💬'}
              </button>
            )}
          </div>
        </div>
      ))}
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

function Adjunto({
  adjunto,
  onAmpliar,
  mensajeId,
  onAbrirDocumento,
}: {
  adjunto: Adjunto
  onAmpliar: (url: string) => void
  mensajeId: string
  onAbrirDocumento: (mensajeId: string) => void
}) {
  if (adjunto.tipo === 'image') {
    return (
      <img
        className="s24-adjunto-img"
        src={adjunto.url}
        alt={adjunto.nombre || 'Imagen'}
        onClick={() => onAmpliar(adjunto.url)}
      />
    )
  }
  if (adjunto.tipo === 'sticker') {
    return <img className="s24-adjunto-sticker" src={adjunto.url} alt="Sticker" onClick={() => onAmpliar(adjunto.url)} />
  }
  if (adjunto.tipo === 'video') {
    return <video className="s24-adjunto-img" src={adjunto.url} controls />
  }
  if (adjunto.tipo === 'audio') {
    return <audio className="s24-adjunto-audio" src={adjunto.url} controls />
  }
  // Los documentos que llegan de Kapso son una URL http(s) externa — hay que pasar por
  // el proxy para que se abran inline (ver /api/adjunto/proxy). Los que mandamos nosotros
  // en modo standalone quedan como `data:` URL propia (sin storage externo, ver
  // ARCHITECTURE.md §17) — esos no necesitan proxy, se linkean directo.
  if (adjunto.url.startsWith('http://') || adjunto.url.startsWith('https://')) {
    return (
      <button type="button" className="s24-adjunto-doc" onClick={() => onAbrirDocumento(mensajeId)}>
        📄 <span>{adjunto.nombre || 'Ver documento'}</span>
      </button>
    )
  }
  return (
    <a className="s24-adjunto-doc" href={adjunto.url} target="_blank" rel="noreferrer" download={adjunto.nombre}>
      📄 <span>{adjunto.nombre || 'Descargar documento'}</span>
    </a>
  )
}
