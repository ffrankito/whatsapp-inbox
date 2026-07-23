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
type PlantillaDisponible = { id: string; etiqueta: string }
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
  ultimoAgente?: Agente
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

// Recordar en qué número/conversación/vista estaba el agente, para que un refresh de la
// página (F5) no vuelva siempre al estado inicial — a diferencia de la identidad o
// "leído" (que si necesitan ser lo mismo para cualquier agente/dispositivo, ver
// ARCHITECTURE.md §26), esto es pura preferencia de navegación de ESTE navegador, tiene
// sentido que viva en localStorage.
const NAV_STORAGE_KEY = 's24_nav'
type NavGuardada = {
  numeroActivo?: NumeroId
  seleccionadaId?: string | null
  vistaAgenda?: boolean
  pantallaMobile?: 'numeros' | 'lista'
}
function leerNavGuardada(): NavGuardada {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

// Tema claro/oscuro: por default sigue al sistema operativo (ver los bloques
// [data-theme] en inbox.css), pero el agente puede forzarlo a mano con el switch del
// header — esa elección se guarda en localStorage y le gana al preference del SO.
const TEMA_STORAGE_KEY = 's24_tema'
function leerTemaGuardado(): 'light' | 'dark' | null {
  if (typeof window === 'undefined') return null
  try {
    const v = localStorage.getItem(TEMA_STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}
function temaDelSistema(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

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
      c.ultimoAgente?.id === d.ultimoAgente?.id &&
      c.ultimoAgente?.nombre === d.ultimoAgente?.nombre &&
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
  // Arranca siempre en 'light' (server y cliente, para que coincidan en el primer
  // render — el server no tiene localStorage) y recién después de montar se corrige
  // con un cambio de estado real si había un tema guardado distinto. Leerlo directo en
  // el useState inicial (como se hace con leerNavGuardada) rompía acá porque el switch
  // es un <input type="checkbox"> controlado: React no siempre vuelve a sincronizar su
  // `checked` en la hidratación si el valor "ya viene así desde el inicio" en vez de
  // llegar por un setState posterior — quedaba el switch marcando un tema que el fondo
  // ya no tenía aplicado.
  const [tema, setTema] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    const guardado = leerTemaGuardado() ?? temaDelSistema()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTema(guardado)
  }, [])
  const alternarTema = useCallback(() => {
    setTema((actual) => {
      const nuevo = actual === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(TEMA_STORAGE_KEY, nuevo) } catch {
        // localStorage lleno o no disponible — no es crítico, se mantiene el tema en memoria.
      }
      return nuevo
    })
  }, [])
  const [numeroActivo, setNumeroActivo] = useState<NumeroId>(() => leerNavGuardada().numeroActivo ?? 'dealers')
  // Un casillero por número, no un solo valor compartido — cada respuesta de
  // /api/conversaciones escribe únicamente en el casillero del número que pidió, así que
  // una respuesta tardía de un número que ya no está activo nunca puede pisar los datos
  // recién cargados de otro número, sin importar en qué orden lleguen las respuestas.
  const [conversacionesPorNumero, setConversacionesPorNumero] = useState<Partial<Record<NumeroId, Conversacion[]>>>({})
  const conversaciones = useMemo(
    () => conversacionesPorNumero[numeroActivo] ?? [],
    [conversacionesPorNumero, numeroActivo],
  )
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(() => leerNavGuardada().seleccionadaId ?? null)
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [texto, setTexto] = useState('')
  const [archivoAdj, setArchivoAdj] = useState<File | null>(null)
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [agentesConocidos, setAgentesConocidos] = useState<Agente[]>([])
  const [plantillasDisponibles, setPlantillasDisponibles] = useState<PlantillaDisponible[]>([])
  const [filtroAgenteId, setFiltroAgenteId] = useState('')
  const [imagenAmpliada, setImagenAmpliada] = useState<string | null>(null)
  // Panel "Archivos y adjuntos" de la conversación (como en WhatsApp, al tocar el
  // nombre del contacto) — se arma con los mensajes ya cargados, no pide nada nuevo
  // al servidor.
  const [panelArchivos, setPanelArchivos] = useState(false)
  // Agenda de contactos (Kapso) del número activo — vista alternativa a la lista de
  // conversaciones, no un panel aparte, para no romper el layout de 3 columnas ya armado.
  const [vistaAgenda, setVistaAgenda] = useState(() => leerNavGuardada().vistaAgenda ?? false)
  // Instagram todavía no tiene backend de verdad (ver docs/BACKLOG.md) — esto solo
  // muestra un placeholder por arriba de la lista/hilo de WhatsApp, sin tocar nada de
  // su lógica (numeroActivo sigue apuntando al último número de WhatsApp elegido).
  const [instagramSeleccionado, setInstagramSeleccionado] = useState(false)
  // Navegación por pantallas en mobile (ver .s24-console[data-pantalla-mobile] en
  // inbox.css) — en desktop las 3 columnas se ven todas juntas y esto no se usa para
  // nada. 'hilo' se deriva de si hay conversación seleccionada, no es un estado propio.
  const [pantallaMobile, setPantallaMobile] = useState<'numeros' | 'lista'>(() => leerNavGuardada().pantallaMobile ?? 'numeros')
  // Bump para que la Agenda se refresque sola cuando llega un evento SSE del número
  // activo (mensaje nuevo) — ver el useEffect de "Tiempo real" más abajo.
  const [agendaRefreshTick, setAgendaRefreshTick] = useState(0)
  // Picker de emoji compartido — uno solo a la vez, se renderiza como panel fijo (no
  // pegado a cada burbuja) para no depender de la posición dentro de .s24-bubbles, que
  // hace scroll y lo cortaba/desalineaba. Sirve tanto para reaccionar a un mensaje como
  // para insertar un emoji en el composer.
  const [pickerEmoji, setPickerEmoji] = useState<{ modo: 'reaccion'; mensajeId: string } | { modo: 'composer' } | null>(null)

  // Reactivar una conversación fuera de la ventana de 24hs con la plantilla aprobada
  // (acceso rápido en el hilo, ver docs/BACKLOG.md #6).
  const [reactivando, setReactivando] = useState(false)
  const [errorReactivar, setErrorReactivar] = useState<string | null>(null)

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
  const bubblesRef = useRef<HTMLDivElement>(null)

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

      fetch('/api/crm/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-s24-inbox': '1' },
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
    // Cerrar el panel al cambiar de conversación no se puede derivar del render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPanelArchivos(false)
  }, [seleccionadaId])

  // Guarda dónde está parado el agente (número/conversación/vista) para que un refresh
  // de la página no vuelva siempre al estado inicial — ver leerNavGuardada() más arriba.
  useEffect(() => {
    try {
      const nav: NavGuardada = { numeroActivo, seleccionadaId, vistaAgenda, pantallaMobile }
      localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(nav))
    } catch {
      // localStorage lleno o no disponible — no es crítico, el próximo cambio reintenta
    }
  }, [numeroActivo, seleccionadaId, vistaAgenda, pantallaMobile])

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

  // Plantillas rápidas disponibles para el número activo (ver docs/BACKLOG.md #6) — se
  // recarga al cambiar de número, cada número puede tener sus propias plantillas
  // aprobadas (o ninguna todavía).
  const cargarPlantillas = useCallback(
    async (numeroPedido: NumeroId) => {
      try {
        const res = await fetch(`/api/plantillas?numero=${numeroPedido}`, { headers: headersConAgente() })
        if (!res.ok) return
        const data = await res.json()
        if (numeroActivoRef.current !== numeroPedido) return
        setPlantillasDisponibles(data.plantillas ?? [])
      } catch {
        // silencioso: no bloquea el resto del inbox
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headersConAgente],
  )

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

  // Plantillas rápidas del número activo — no cambian seguido, alcanza con recargar al
  // cambiar de número (no hace falta poll).
  useEffect(() => {
    if (!ssoListo) return
    // Fetch de datos externos, no hay forma de derivarlo del render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarPlantillas(numeroActivo)
  }, [ssoListo, numeroActivo, cargarPlantillas])

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
    // Limpiar siempre (no solo cuando no hay conversación elegida) — si no, al cambiar
    // de chat A a chat B los mensajes de A quedan visibles hasta que termine de cargar
    // B (fetch async), y por un instante se renderiza el hilo VIEJO con la identidad
    // (conversacionId) del chat NUEVO ya seleccionada — eso hace, por ejemplo, que el
    // proxy de adjuntos pida un mensaje real pero con el conversacionId de otro chat y
    // tire 404. También hacía que el scroll-al-final calculara sobre contenido que no
    // era el del chat recién abierto.
    setMensajes([])
    if (!seleccionadaId) return
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

  // Al abrir una conversación (o llegar un mensaje nuevo) hay que quedar parado en el
  // último mensaje, no arriba de todo — el scroll nace en el tope del contenedor si no
  // se fuerza esto explícitamente. Se hace en dos rAF (no un setTimeout arbitrario):
  // en mobile, .s24-bubbles vive dentro de .s24-thread, que pasa de display:none a
  // flex en el mismo render en que se abre el chat — hasta que el navegador no pinta
  // ese cambio, el contenedor no tiene layout real y scrollHeight puede quedar corto.
  // Esperar el próximo frame (y uno más, para que asiente) garantiza que ya hay layout.
  useEffect(() => {
    const el = bubblesRef.current
    if (!el) return
    let id2 = 0
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    })
    return () => {
      cancelAnimationFrame(id1)
      cancelAnimationFrame(id2)
    }
  }, [seleccionadaId, mensajes])

  // Las imágenes/videos de los adjuntos terminan de cargar DESPUÉS del scroll de arriba
  // (llegan de a poco, ya con el mensaje en el DOM) — cada una que carga empuja el resto
  // del hilo hacia abajo, así que sin esto el scroll queda corto del final "de verdad"
  // una vez que todo terminó de renderizarse. Solo reengancha si ya estaba cerca del
  // final, para no arrastrar al agente si scrolleó para arriba a leer historial viejo.
  const reengancharAlFinalSiCorresponde = useCallback(() => {
    const el = bubblesRef.current
    if (!el) return
    const cercaDelFinal = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (cercaDelFinal) el.scrollTop = el.scrollHeight
  }, [])

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

  // "Ahora" como estado (no Date.now() directo durante el render, que el compilador de
  // React marca como impuro) — se actualiza solo cada un minuto, de sobra para algo que
  // se mide en horas. Arranca en null (no en Date.now()) para no llamar algo impuro ni
  // siquiera en el valor inicial; hasta que el efecto corre la primera vez, se asume la
  // ventana abierta (evita un parpadeo mostrando "cerrada" antes de tiempo).
  const [ahora, setAhora] = useState<number | null>(null)
  useEffect(() => {
    // Leer el reloj no se puede derivar del render (es justamente lo impuro que se
    // está evitando ahí) — tiene que vivir en un efecto sí o sí.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAhora(Date.now())
    const interval = setInterval(() => setAhora(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])

  // WhatsApp solo deja mandar texto libre hasta 24hs después del último mensaje que
  // mandó el CONTACTO (no el agente) — pasado eso, hace falta un mensaje de plantilla
  // para "reactivar" la conversación (ver docs/BACKLOG.md #6). Si nunca hubo un mensaje
  // entrante (ej. una conversación recién arrancada con plantilla, todavía sin
  // respuesta) se trata igual que ventana cerrada — es la misma regla real de Meta.
  // Sin useMemo a propósito: el compilador de React no podía preservar la memoización acá
  // (efecto colateral de tener el estado de "ahora" cerca) — de todas formas es un loop
  // sobre a lo sumo un puñado de cientos de mensajes, recalcularlo en cada render no
  // cuesta nada.
  let ultimoInboundEn: number | null = null
  for (let i = mensajes.length - 1; i >= 0; i--) {
    if (mensajes[i].direction === 'inbound') {
      ultimoInboundEn = new Date(mensajes[i].dateAdded).getTime()
      break
    }
  }
  const ventanaAbierta = ahora === null || (ultimoInboundEn !== null && ahora - ultimoInboundEn < 24 * 60 * 60 * 1000)
  // Gatea específicamente el composer de texto libre — el resto de las acciones
  // (notas, reacciones, liberar/cerrar) no dependen de la ventana de 24hs, solo de ser
  // el dueño de la conversación (puedeEscribir).
  const puedeEscribirTexto = puedeEscribir && ventanaAbierta

  // Archivos y adjuntos de la conversación activa (como en WhatsApp al tocar el nombre
  // del contacto) — se arma con los mensajes ya cargados, sin pedir nada nuevo.
  const adjuntosDeLaConversacion = useMemo(() => {
    const conAdjunto = mensajes.filter((m): m is Mensaje & { adjunto: Adjunto } => !!m.adjunto)
    return {
      imagenes: conAdjunto.filter((m) => m.adjunto.tipo === 'image' || m.adjunto.tipo === 'sticker'),
      videos: conAdjunto.filter((m) => m.adjunto.tipo === 'video'),
      documentos: conAdjunto.filter((m) => m.adjunto.tipo === 'document'),
      audios: conAdjunto.filter((m) => m.adjunto.tipo === 'audio'),
    }
  }, [mensajes])

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

  // Manda el mensaje de plantilla para "despertar" una conversación que ya pasó las
  // 24hs — reusa la misma ruta que arranca conversaciones nuevas desde la Agenda,
  // porque encontrarOCrearConversacion ahí adentro ya maneja bien el caso de que la
  // conversación exista (no crea una duplicada, sigue usando la misma).
  function reactivarConversacion(plantillaId: string) {
    if (!seleccionada?.phone) return
    setReactivando(true)
    setErrorReactivar(null)
    fetch(`/api/contactos/${encodeURIComponent(seleccionada.phone)}/conversacion?numero=${numeroActivo}`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ nombre: seleccionada.fullName || seleccionada.contactName, plantillaId }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'No se pudo reactivar la conversación')
        return data
      })
      .then(() => refrescarTodo())
      .catch((err: Error) => setErrorReactivar(err.message))
      .finally(() => setReactivando(false))
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
      <div className="s24-inbox" data-theme={tema}>
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setGoogleScriptListo(true)} />
      </div>
    )
  }

  if (!agente) {
    return (
      <div className="s24-inbox" data-theme={tema}>
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
    <div className="s24-inbox" data-theme={tema}>
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
          <label id="s24-tt" title={tema === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}>
            <input
              id="s24-tt-input"
              type="checkbox"
              checked={tema === 'dark'}
              onChange={alternarTema}
              aria-label="Modo oscuro"
            />
            <svg viewBox="0 0 69.667 44" xmlns="http://www.w3.org/2000/svg">
              <g transform="translate(3.5 3.5)">
                <rect id="s24-tt-container" fill="#83cbd8" rx="17.5" height="35" width="60.667"></rect>
                <g id="s24-tt-button" transform="translate(2.333 2.333)">
                  <g id="s24-tt-sun">
                    <circle fill="#f8e664" r="15.167" cy="15.167" cx="15.167"></circle>
                    <path fill="rgba(246,254,247,0.29)" transform="translate(3.5 3.5)" d="M11.667,0A11.667,11.667,0,1,1,0,11.667,11.667,11.667,0,0,1,11.667,0Z"></path>
                    <circle fill="#fcf4b9" transform="translate(8.167 8.167)" r="7" cy="7" cx="7"></circle>
                  </g>
                  <g id="s24-tt-moon">
                    <circle fill="#cce6ee" r="15.167" cy="15.167" cx="15.167"></circle>
                    <g fill="#a6cad0" transform="translate(-24.415 -1.009)">
                      <circle transform="translate(43.009 4.496)" r="2" cy="2" cx="2"></circle>
                      <circle transform="translate(39.366 17.952)" r="2" cy="2" cx="2"></circle>
                      <circle transform="translate(33.016 8.044)" r="1" cy="1" cx="1"></circle>
                      <circle transform="translate(51.081 18.888)" r="1" cy="1" cx="1"></circle>
                      <circle transform="translate(33.016 22.503)" r="1" cy="1" cx="1"></circle>
                      <circle transform="translate(50.081 10.53)" r="1.5" cy="1.5" cx="1.5"></circle>
                    </g>
                  </g>
                </g>
                <path id="s24-tt-cloud" fill="#fff" transform="translate(-3469.97 -164.44)" d="M3512.81,173.815a4.463,4.463,0,0,1,2.243.62.95.95,0,0,1,.72-1.281,4.852,4.852,0,0,1,2.623.519c.034.02-.5-1.968.281-2.716a2.117,2.117,0,0,1,2.829-.274,1.821,1.821,0,0,1,.854,1.858c.063.037,2.594-.049,3.285,1.273s-.865,2.544-.807,2.626a12.192,12.192,0,0,1,2.278.892c.553.448,1.106,1.992-1.62,2.927a7.742,7.742,0,0,1-3.762-.3c-1.28-.49-1.181-2.65-1.137-2.624s-1.417,2.2-2.623,2.2a4.172,4.172,0,0,1-2.394-1.206,3.825,3.825,0,0,1-2.771.774c-3.429-.46-2.333-3.267-2.2-3.55A3.721,3.721,0,0,1,3512.81,173.815Z"></path>
                <g id="s24-tt-stars" fill="#def8ff" transform="translate(3.585 1.325)">
                  <path transform="matrix(-1, 0.017, -0.017, -1, 24.231, 3.055)" d="M.774,0,.566.559,0,.539.458.933.25,1.492l.485-.361.458.394L1.024.953,1.509.592.943.572Z"></path>
                  <path transform="matrix(-0.777, 0.629, -0.629, -0.777, 23.185, 12.358)" d="M1.341.529.836.472.736,0,.505.46,0,.4.4.729l-.231.46L.605.932l.4.326L.9.786Z"></path>
                  <path transform="matrix(0.438, 0.899, -0.899, 0.438, 23.177, 29.735)" d="M.015,1.065.475.9l.285.365L.766.772l.46-.164L.745.494.751,0,.481.407,0,.293.285.658Z"></path>
                  <path transform="translate(12.677 0.388) rotate(104)" d="M1.161,1.6,1.059,1,1.574.722.962.607.86,0,.613.572,0,.457.446.881.2,1.454l.516-.274Z"></path>
                  <path transform="matrix(-0.07, 0.998, -0.998, -0.07, 11.066, 15.457)" d="M.873,1.648l.114-.62L1.579.945,1.03.62,1.144,0,.706.464.157.139.438.7,0,1.167l.592-.083Z"></path>
                  <path transform="translate(8.326 28.061) rotate(11)" d="M.593,0,.638.724,0,.982l.7.211.045.724.36-.64.7.211L1.342.935,1.7.294,1.063.552Z"></path>
                  <path transform="translate(5.012 5.962) rotate(172)" d="M.816,0,.5.455,0,.311.323.767l-.312.455.516-.215.323.456L.827.911,1.343.7.839.552Z"></path>
                  <path transform="translate(2.218 14.616) rotate(169)" d="M1.261,0,.774.571.114.3.487.967,0,1.538.728,1.32l.372.662.047-.749.728-.218L1.215.749Z"></path>
                </g>
              </g>
            </svg>
          </label>
          <button type="button" className="s24-logout" onClick={cerrarSesion}>Cerrar sesión</button>
        </div>
      </div>

      <div
        className="s24-console"
        data-numero={numeroActivo}
        data-instagram={String(instagramSeleccionado)}
        data-pantalla-mobile={seleccionada ? 'hilo' : pantallaMobile}
      >
        <nav className="s24-numbers">
          <div className="eyebrow">Números</div>
          {NUMEROS.map((n) => (
            <button
              key={n.id}
              className="s24-num-btn"
              data-numero={n.id}
              data-active={String(n.id === numeroActivo && !instagramSeleccionado)}
              onClick={() => {
                setInstagramSeleccionado(false)
                if (n.id !== numeroActivo) {
                  setNumeroActivo(n.id)
                  setSeleccionadaId(null)
                }
                // En mobile, tocar un número siempre avanza a la pantalla de
                // contenido — aunque ya fuera el activo (ver .s24-console[data-pantalla-mobile]).
                setPantallaMobile('lista')
              }}
            >
              <span className="row1">
                <span className="s24-num-ico"><n.Icono /></span>
                <span className="name">{n.nombre}</span>
              </span>
            </button>
          ))}

          <div className="eyebrow s24-canales-divisor">Redes sociales</div>
          <button
            type="button"
            className="s24-num-btn"
            data-numero="instagram"
            data-active={String(instagramSeleccionado)}
            onClick={() => {
              setInstagramSeleccionado(true)
              setPantallaMobile('lista')
            }}
          >
            <span className="row1">
              <span className="s24-num-ico"><IconoInstagram /></span>
              <span className="name">Instagram</span>
            </span>
          </button>
        </nav>

        {instagramSeleccionado && (
          <div className="s24-instagram-placeholder">
            <div className="s24-instagram-placeholder-card">
              <div className="s24-tv-wrapper">
                <div className="s24-tv-main">
                  <div className="s24-tv-antenna">
                    <div className="s24-tv-antenna-shadow"></div>
                    <div className="s24-tv-a1"></div>
                    <div className="s24-tv-a1d"></div>
                    <div className="s24-tv-a2"></div>
                    <div className="s24-tv-a2d"></div>
                  </div>
                  <div className="s24-tv-set">
                    <div className="s24-tv-curve">
                      <svg
                        className="s24-tv-curve-svg"
                        version="1.1"
                        xmlns="http://www.w3.org/2000/svg"
                        xmlnsXlink="http://www.w3.org/1999/xlink"
                        viewBox="0 0 189.929 189.929"
                      >
                        <path
                          d="M70.343,70.343c-30.554,30.553-44.806,72.7-39.102,115.635l-29.738,3.951C-5.442,137.659,11.917,86.34,49.129,49.13
                      C86.34,11.918,137.664-5.445,189.928,1.502l-3.95,29.738C143.041,25.54,100.895,39.789,70.343,70.343z"
                        ></path>
                      </svg>
                    </div>
                    <div className="s24-tv-display">
                      <div className="s24-tv-screen-out">
                        <div className="s24-tv-screen-out1">
                          <div className="s24-tv-screen-mobile">
                            <span className="s24-tv-notfound-text">PRONTO</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="s24-tv-lines">
                      <div className="s24-tv-line1"></div>
                      <div className="s24-tv-line2"></div>
                      <div className="s24-tv-line3"></div>
                    </div>
                    <div className="s24-tv-buttons">
                      <div className="s24-tv-b1"><div></div></div>
                      <div className="s24-tv-b2"></div>
                      <div className="s24-tv-speakers">
                        <div className="s24-tv-g1">
                          <div className="s24-tv-g11"></div>
                          <div className="s24-tv-g12"></div>
                          <div className="s24-tv-g13"></div>
                        </div>
                        <div className="s24-tv-g"></div>
                        <div className="s24-tv-g"></div>
                      </div>
                    </div>
                  </div>
                  <div className="s24-tv-bottom">
                    <div className="s24-tv-base1"></div>
                    <div className="s24-tv-base2"></div>
                    <div className="s24-tv-base3"></div>
                  </div>
                </div>
              </div>
              <h2>Instagram</h2>
              <p>
                Ya está conectado el webhook con Meta y confirmado que recibe mensajes reales —
                todavía falta la parte visible: guardar las conversaciones, armar la agenda de
                contactos, y poder responder desde acá.
              </p>
              <span className="s24-chip lock">En construcción</span>
            </div>
          </div>
        )}

        <div className="s24-convlist">
          <div className="s24-convlist-tabs">
            <button type="button" className="s24-mobile-back" onClick={() => setPantallaMobile('numeros')} aria-label="Volver a números">
              ←
            </button>
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
                <DropdownAgentes
                  agentesConocidos={agentesConocidos}
                  filtroAgenteId={filtroAgenteId}
                  setFiltroAgenteId={setFiltroAgenteId}
                  agenteId={agente.id}
                />
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
                  {c.estado !== 'asignada' && c.ultimoAgente && (
                    <div className="s24-conv-last-agent">👤 Atendida por <b>{c.ultimoAgente.nombre}</b></div>
                  )}
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
                  <button type="button" className="s24-mobile-back" onClick={() => setSeleccionadaId(null)} aria-label="Volver a la lista">
                    ←
                  </button>
                  <button
                    type="button"
                    className="s24-thread-who-btn"
                    onClick={() => setPanelArchivos(true)}
                    title="Ver archivos y adjuntos de esta conversación"
                  >
                    <span className="s24-avatar lg">{iniciales(seleccionada.fullName || seleccionada.contactName || seleccionada.phone || '?')}</span>
                    <span className="who-text">
                      <span className="name">{seleccionada.fullName || seleccionada.contactName || 'Sin nombre'}</span>
                      <span className="id">{seleccionada.phone}</span>
                    </span>
                  </button>
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
              {puedeEscribir && !ventanaAbierta && (
                <div className="s24-lock-banner critical">
                  🔒 Ventana cerrada. Pasaron más de 24hs sin actividad del contacto — WhatsApp no permite
                  mandar mensajes libres hasta que el contacto vuelva a escribir. Podés reactivarla con una
                  plantilla aprobada:
                  {plantillasDisponibles.length === 0 ? (
                    <div className="s24-plantillas-vacio">Este número todavía no tiene ninguna plantilla aprobada.</div>
                  ) : (
                    <div className="s24-plantillas-rapidas">
                      {plantillasDisponibles.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="s24-plantilla-btn"
                          onClick={() => reactivarConversacion(p.id)}
                          disabled={reactivando}
                        >
                          {p.etiqueta}
                        </button>
                      ))}
                    </div>
                  )}
                  {errorReactivar && <div className="s24-agenda-error" style={{ maxWidth: 'none' }}>{errorReactivar}</div>}
                </div>
              )}

              <div className="s24-bubbles" ref={bubblesRef}>
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
                        {m.adjunto && (
                          <Adjunto
                            adjunto={m.adjunto}
                            onAmpliar={setImagenAmpliada}
                            mensajeId={m.id}
                            conversacionId={seleccionada.id}
                            onAbrirDocumento={abrirDocumento}
                            onCargado={reengancharAlFinalSiCorresponde}
                          />
                        )}
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
                      <label className="s24-attach" data-disabled={String(!puedeEscribirTexto)}>
                        <IconoClip />
                        <input
                          type="file"
                          hidden
                          disabled={!puedeEscribirTexto}
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
                        disabled={!puedeEscribirTexto}
                        onClick={() => setPickerEmoji(pickerEmoji?.modo === 'composer' ? null : { modo: 'composer' })}
                      >
                        🙂
                      </button>
                      <input
                        type="text"
                        placeholder={
                          archivoAdj
                            ? 'Agregar un mensaje (opcional)…'
                            : puedeEscribirTexto
                              ? 'Escribir una respuesta…'
                              : puedeEscribir && !ventanaAbierta
                                ? 'Ventana cerrada — el contacto debe escribir primero'
                                : 'Tomá la conversación para responder'
                        }
                        value={texto}
                        disabled={!puedeEscribirTexto}
                        onChange={(e) => {
                          setTexto(e.target.value)
                          if (e.target.value) avisarEscribiendo()
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && enviar()}
                      />
                      {texto.trim() || archivoAdj ? (
                        <button className="s24-btn primary round" onClick={enviar} disabled={!puedeEscribirTexto || enviando} title="Enviar">
                          <IconoEnviar />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="s24-attach"
                          title="Grabar audio"
                          disabled={!puedeEscribirTexto}
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
        <div className="s24-lightbox s24-lightbox-encima" onClick={() => setImagenAmpliada(null)}>
          <button type="button" className="s24-lightbox-cerrar" onClick={() => setImagenAmpliada(null)} aria-label="Cerrar">
            <IconoX />
          </button>
          <img src={imagenAmpliada} alt="Imagen ampliada" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {panelArchivos && seleccionada && (
        <div className="s24-lightbox" onClick={() => setPanelArchivos(false)}>
          <button type="button" className="s24-lightbox-cerrar" onClick={() => setPanelArchivos(false)} aria-label="Cerrar">
            <IconoX />
          </button>
          <div className="s24-panel-archivos" onClick={(e) => e.stopPropagation()}>
            <h2>Archivos y adjuntos</h2>
            <p className="sub">{seleccionada.fullName || seleccionada.contactName || seleccionada.phone}</p>
            {Object.values(adjuntosDeLaConversacion).every((lista) => lista.length === 0) ? (
              <div className="empty">Todavía no se compartió ningún archivo en esta conversación.</div>
            ) : (
              <>
                {(adjuntosDeLaConversacion.imagenes.length > 0 || adjuntosDeLaConversacion.videos.length > 0) && (
                  <section>
                    <h3>Fotos y videos ({adjuntosDeLaConversacion.imagenes.length + adjuntosDeLaConversacion.videos.length})</h3>
                    <div className="s24-panel-grid">
                      {[...adjuntosDeLaConversacion.imagenes, ...adjuntosDeLaConversacion.videos].map((m) => (
                        <div key={m.id} className="s24-panel-thumb">
                          <Adjunto adjunto={m.adjunto} onAmpliar={setImagenAmpliada} mensajeId={m.id} conversacionId={seleccionada.id} onAbrirDocumento={abrirDocumento} />
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {adjuntosDeLaConversacion.documentos.length > 0 && (
                  <section>
                    <h3>Documentos ({adjuntosDeLaConversacion.documentos.length})</h3>
                    <div className="s24-panel-lista">
                      {adjuntosDeLaConversacion.documentos.map((m) => (
                        <Adjunto key={m.id} adjunto={m.adjunto} onAmpliar={setImagenAmpliada} mensajeId={m.id} conversacionId={seleccionada.id} onAbrirDocumento={abrirDocumento} />
                      ))}
                    </div>
                  </section>
                )}
                {adjuntosDeLaConversacion.audios.length > 0 && (
                  <section>
                    <h3>Audios ({adjuntosDeLaConversacion.audios.length})</h3>
                    <div className="s24-panel-lista">
                      {adjuntosDeLaConversacion.audios.map((m) => (
                        <Adjunto key={m.id} adjunto={m.adjunto} onAmpliar={setImagenAmpliada} mensajeId={m.id} conversacionId={seleccionada.id} onAbrirDocumento={abrirDocumento} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
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

function IconoInstagram({ grande }: { grande?: boolean }) {
  const s = grande ? 40 : 16
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  )
}

// Dropdown propio para filtrar por agente — reemplaza un <select> nativo, cuyo botón
// cerrado se puede estilar lindo, pero la lista desplegada la dibuja el sistema
// operativo (no CSS nuestro), y se ve genérica sin importar qué le pongamos alrededor.
function DropdownAgentes({
  agentesConocidos,
  filtroAgenteId,
  setFiltroAgenteId,
  agenteId,
}: {
  agentesConocidos: Agente[]
  filtroAgenteId: string
  setFiltroAgenteId: (id: string) => void
  agenteId: string
}) {
  const [abierto, setAbierto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!abierto) return
    function onClickFuera(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false)
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setAbierto(false)
    }
    document.addEventListener('mousedown', onClickFuera)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onClickFuera)
      document.removeEventListener('keydown', onEscape)
    }
  }, [abierto])

  const seleccionado = agentesConocidos.find((a) => a.id === filtroAgenteId)
  const etiqueta = seleccionado ? `${seleccionado.nombre}${seleccionado.id === agenteId ? ' (vos)' : ''}` : 'Todos los agentes'

  function elegir(id: string) {
    setFiltroAgenteId(id)
    setAbierto(false)
  }

  return (
    <div className="s24-dropdown" ref={ref}>
      <button
        type="button"
        className="s24-dropdown-trigger"
        onClick={() => setAbierto((v) => !v)}
        title="Ver solo las conversaciones tomadas por un agente"
      >
        <span className="txt">{etiqueta}</span>
        <span className="chev" data-abierto={String(abierto)}>▾</span>
      </button>
      {abierto && (
        <div className="s24-dropdown-lista">
          <button type="button" className="s24-dropdown-item" data-active={String(!filtroAgenteId)} onClick={() => elegir('')}>
            Todos los agentes
          </button>
          {agentesConocidos.map((a) => (
            <button
              key={a.id}
              type="button"
              className="s24-dropdown-item"
              data-active={String(a.id === filtroAgenteId)}
              onClick={() => elegir(a.id)}
            >
              {a.nombre}{a.id === agenteId ? ' (vos)' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// profileName: nombre que el contacto puso en su propio WhatsApp, de solo lectura.
// displayName: apodo propio de Kapso, editable — es lo que en la práctica se muestra/
// edita como "el nombre guardado" en la agenda (ver actualizarContactoKapso).
type ContactoAgenda = { id: string; waId: string; profileName?: string; displayName?: string; customerId?: string }

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
  const [iniciandoWaId, setIniciandoWaId] = useState<string | null>(null)
  const [errorIniciar, setErrorIniciar] = useState<{ waId: string; mensaje: string } | null>(null)
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
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    numeroRef.current = numero
  }, [numero])

  // Trae SIEMPRE la lista completa del número (sin filtrar por búsqueda) — filtrar es
  // 100% en memoria (ver contactosFiltrados más abajo), no hace falta volver a pedirle
  // nada a Kapso en cada tecla que se escribe en el buscador. Antes sí volvía a pedir
  // todo de nuevo por cada letra tipeada, y como esto ahora trae TODAS las páginas (ver
  // el fix de paginación), tipear se sentía carísimo/lento.
  const cargarContactos = useCallback(
    (numeroPedido: NumeroId) => {
      setCargando(true)
      setError(false)
      const params = new URLSearchParams({ numero: numeroPedido })
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
    // Cambiar de número limpia y recarga al toque — también reinicia la línea de base
    // de "nuevo" (es por número, no global).
    setContactos([])
    setNuevosWaIds(new Set())
    vistosRef.current = new Set()
    primeraCargaRef.current = true
    setBusqueda('')
    cargarContactos(numero)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numero, cargarContactos])

  // Refresco en tiempo real: cuando llega un mensaje del número activo (mismo evento
  // SSE que usa el chat), la agenda se recarga sola — un contacto nuevo se agrega solo
  // al directorio de Kapso apenas escribe, así que reaparece acá sin que nadie recargue
  // la página.
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    cargarContactos(numero)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  // Buscar es 100% en memoria sobre lo ya traído — nunca dispara un pedido nuevo.
  const contactosFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return contactos
    return contactos.filter(
      (c) => c.displayName?.toLowerCase().includes(q) || c.profileName?.toLowerCase().includes(q) || c.waId.toLowerCase().includes(q),
    )
  }, [contactos, busqueda])

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
    setNombreEdit(c.displayName ?? c.profileName ?? '')
  }

  function guardarEdicion(waId: string) {
    const nombre = nombreEdit.trim()
    if (!nombre) return
    fetch(`/api/contactos/${encodeURIComponent(waId)}?numero=${numero}`, {
      method: 'PATCH',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ displayName: nombre }),
    })
      .then((res) => (res.ok ? cargarContactos(numero) : undefined))
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

  // Manda el mensaje de plantilla aprobado por Meta para arrancar la conversación (ver
  // docs/BACKLOG.md #6) — es la única forma de escribirle primero a alguien en WhatsApp.
  function iniciarConversacion(c: ContactoAgenda) {
    setIniciandoWaId(c.waId)
    setErrorIniciar(null)
    fetch(`/api/contactos/${encodeURIComponent(c.waId)}/conversacion?numero=${numero}`, {
      method: 'POST',
      headers: headersConAgente({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ nombre: c.displayName || c.profileName }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'No se pudo iniciar la conversación')
        return data
      })
      .then((data) => {
        setSinConversacionWaId(null)
        onAbrirConversacion(data.conversacionId)
      })
      .catch((err: Error) => setErrorIniciar({ waId: c.waId, mensaje: err.message }))
      .finally(() => setIniciandoWaId(null))
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
      {!cargando && !error && contactosFiltrados.length === 0 && (
        <div className="empty">{busqueda ? 'Ningún contacto coincide con la búsqueda.' : 'Sin contactos todavía.'}</div>
      )}
      {!cargando && !error && contactosFiltrados.map((c) => (
        <div
          key={c.id}
          className="s24-agenda-item"
          onClick={() => nuevosWaIds.has(c.waId) && descartarNuevo(c.waId)}
        >
          <span className="s24-avatar">{iniciales(c.displayName || c.profileName || c.waId)}</span>
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
              <span className="who">
                {c.displayName || c.profileName || 'Sin nombre'}
                {c.displayName && c.profileName && c.displayName !== c.profileName && (
                  <span className="s24-agenda-profile-name"> ({c.profileName})</span>
                )}
              </span>
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
              errorIniciar?.waId === c.waId ? (
                <span className="s24-agenda-error" title={errorIniciar.mensaje}>{errorIniciar.mensaje}</span>
              ) : (
                <button
                  type="button"
                  className="s24-agenda-btn-iniciar"
                  onClick={() => iniciarConversacion(c)}
                  disabled={iniciandoWaId === c.waId}
                >
                  {iniciandoWaId === c.waId ? 'Mandando…' : 'Iniciar conversación'}
                </button>
              )
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

// Nuestro storage propio (MinIO) es un bucket PRIVADO — nunca es una URL que el
// navegador pueda pedir directo, ni aunque quisiera (no tiene las credenciales). Todo lo
// que quedó guardado ahí (fotos/audios/videos/documentos, ver src/lib/storage.ts) tiene
// que pasar por /api/adjunto/proxy sí o sí, no solo los documentos como antes.
const PREFIJO_STORAGE = 's24storage://'

function Adjunto({
  adjunto,
  onAmpliar,
  mensajeId,
  conversacionId,
  onAbrirDocumento,
  onCargado,
}: {
  adjunto: Adjunto
  onAmpliar: (url: string) => void
  mensajeId: string
  conversacionId: string
  onAbrirDocumento: (mensajeId: string) => void
  onCargado?: () => void
}) {
  const enNuestroStorage = adjunto.url.startsWith(PREFIJO_STORAGE)
  const esLinkExternoDeKapso = adjunto.url.startsWith('http://') || adjunto.url.startsWith('https://')
  // Si está en nuestro storage, la única forma de verlo es a través del proxy
  // autenticado (el bucket es privado). Si es un link real de Kapso, se puede pedir
  // directo (imagen/audio/video ya se ven bien así, Kapso no les manda
  // Content-Disposition: attachment). Si es una `data:` URL vieja (de antes de este
  // cambio), se usa tal cual, ya viene embebida.
  const src = enNuestroStorage
    ? `/api/adjunto/proxy?conversacionId=${encodeURIComponent(conversacionId)}&mensajeId=${encodeURIComponent(mensajeId)}`
    : adjunto.url

  if (adjunto.tipo === 'image') {
    return (
      <img
        className="s24-adjunto-img"
        src={src}
        alt={adjunto.nombre || 'Imagen'}
        onClick={() => onAmpliar(src)}
        onLoad={onCargado}
      />
    )
  }
  if (adjunto.tipo === 'sticker') {
    return <img className="s24-adjunto-sticker" src={src} alt="Sticker" onClick={() => onAmpliar(src)} onLoad={onCargado} />
  }
  if (adjunto.tipo === 'video') {
    return <video className="s24-adjunto-img" src={src} controls onLoadedMetadata={onCargado} />
  }
  if (adjunto.tipo === 'audio') {
    return <audio className="s24-adjunto-audio" src={src} controls />
  }
  // Documentos: si hace falta pasar por el proxy (nuestro storage o un link http(s) de
  // Kapso), el click dispara fetch+blob para poder abrirlo inline sin forzar "Guardar
  // como" (ver abrirDocumento en el componente principal). Si es una `data:` URL vieja,
  // se linkea directo, sin el atributo download (si no, el navegador fuerza descarga
  // igual para cualquier data: URL, sin importar el tipo de archivo).
  if (enNuestroStorage || esLinkExternoDeKapso) {
    return (
      <button type="button" className="s24-adjunto-doc" onClick={() => onAbrirDocumento(mensajeId)}>
        📄 <span>{adjunto.nombre || 'Ver documento'}</span>
      </button>
    )
  }
  return (
    <a className="s24-adjunto-doc" href={adjunto.url} target="_blank" rel="noreferrer">
      📄 <span>{adjunto.nombre || 'Ver documento'}</span>
    </a>
  )
}
