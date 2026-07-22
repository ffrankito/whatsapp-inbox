import type { NumeroId } from '@/lib/ghl/numeros'
import type { Adjunto, EstadoMensaje } from '@/lib/mensaje'
import type { EstadoConversacion, Agente } from '@/lib/standalone/store'

export type DemoMensaje = {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  dateAdded: string
  adjunto?: Adjunto
  status?: EstadoMensaje
  reaccion?: string
}

export type DemoConversacion = {
  id: string
  contactId: string
  fullName: string
  phone: string
  unreadCount: number
  mensajes: DemoMensaje[]
  estado: EstadoConversacion
  asignadaA?: Agente
  vistoHastaMensajeId?: string
}

function msg(id: string, body: string, direction: 'inbound' | 'outbound', minutosAtras: number, adjunto?: Adjunto): DemoMensaje {
  return {
    id,
    body,
    direction,
    dateAdded: new Date(Date.now() - minutosAtras * 60_000).toISOString(),
    adjunto,
    status: direction === 'outbound' ? 'read' : undefined,
  }
}

export const DEMO_SEED: Record<NumeroId, DemoConversacion[]> = {
  dealers: [
    {
      id: 'demo-c1',
      contactId: 'demo-contact-c1',
      fullName: 'Alarmas del Sur',
      phone: '+54 341 511-2098',
      unreadCount: 0,
      estado: 'sin_asignar',
      mensajes: [
        msg('demo-c1-1', 'Hola, ¿cuándo llega el técnico para la instalación de mañana?', 'inbound', 80),
        msg('demo-c1-2', 'Hola! Está agendado para las 9hs, zona norte.', 'outbound', 79),
        msg('demo-c1-3', 'Perfecto, gracias', 'inbound', 78),
        msg('demo-c1-4', 'Te paso el remito de la instalación', 'outbound', 77, {
          url: 'https://upload.wikimedia.org/wikipedia/commons/8/87/PDF_file_icon.svg',
          tipo: 'document',
          nombre: 'remito-instalacion.pdf',
        }),
      ],
    },
    {
      id: 'demo-c2',
      contactId: 'demo-contact-c2',
      fullName: 'Seguridad Rosario Norte',
      phone: '+54 341 622-4471',
      unreadCount: 1,
      estado: 'sin_asignar',
      mensajes: [
        msg('demo-c2-1', 'Buenas, necesito el código de baja del cliente 4521 para hacer el service', 'inbound', 45),
      ],
    },
    {
      id: 'demo-c3',
      contactId: 'demo-contact-c3',
      fullName: 'Monitoreo Pergamino',
      phone: '+54 336 445-1120',
      unreadCount: 0,
      estado: 'cerrada',
      mensajes: [
        msg('demo-c3-1', '¿Me pueden reenviar la factura de junio?', 'inbound', 1500),
        msg('demo-c3-2', 'Sí, te la reenvío ahora mismo', 'outbound', 1495),
        msg('demo-c3-3', 'Perfecto, gracias!', 'inbound', 1480),
      ],
    },
  ],
  abonados: [
    {
      id: 'demo-a1',
      contactId: 'demo-contact-a1',
      fullName: 'María Fernández — Abonado #8842',
      phone: '+54 341 588-3312',
      unreadCount: 2,
      estado: 'asignada',
      asignadaA: { id: 'demo-agente-1', nombre: 'Ornella' },
      mensajes: [
        msg('demo-a1-1', 'Hola, se disparó la alarma de la cochera hace 5 minutos', 'inbound', 12),
        msg('demo-a1-2', 'no fui yo, no sé qué pasó', 'inbound', 11),
        msg('demo-a1-3', 'Hola María, ya estamos revisando las cámaras de tu domicilio. ¿Está todo bien ahí?', 'outbound', 9),
        msg('demo-a1-4', 'sí, está todo bien, no hay nadie en casa', 'inbound', 8),
        msg('demo-a1-5', '', 'inbound', 7, {
          url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/Sample-audio.ogg',
          tipo: 'audio',
        }),
      ],
    },
    {
      id: 'demo-a2',
      contactId: 'demo-contact-a2',
      fullName: 'Roberto Giménez — Abonado #3310',
      phone: '+54 341 402-7765',
      unreadCount: 1,
      estado: 'sin_asignar',
      mensajes: [
        msg('demo-a2-1', 'Buenas, quiero dar de baja el servicio, me mudo de ciudad', 'inbound', 1440),
      ],
    },
  ],
  fullapp: [
    {
      id: 'demo-f1',
      contactId: 'demo-contact-f1',
      fullName: 'Carlos Medina — Full App',
      phone: '+54 341 677-9021',
      unreadCount: 1,
      estado: 'sin_asignar',
      mensajes: [
        msg('demo-f1-1', 'Hola, la app me tira error al intentar armar el sistema', 'inbound', 200),
        msg('demo-f1-2', 'Mirá la captura', 'inbound', 199, {
          url: 'https://upload.wikimedia.org/wikipedia/commons/a/a3/June_odd-eyed-cat_cropped.jpg',
          tipo: 'image',
        }),
      ],
    },
    {
      id: 'demo-f2',
      contactId: 'demo-contact-f2',
      fullName: 'Estudio Contable SRL — Full App',
      phone: '+54 341 455-8890',
      unreadCount: 0,
      estado: 'cerrada',
      mensajes: [
        msg('demo-f2-1', 'Cambié de celular, ¿cómo reinstalo la app?', 'inbound', 4000),
        msg('demo-f2-2', 'Te paso el link de descarga y el paso a paso', 'outbound', 3990),
        msg('demo-f2-3', 'todo funcionando bien, gracias', 'inbound', 3900),
      ],
    },
  ],
}
