import type { Agente } from '@/lib/standalone/store'

// Directorio en memoria de agentes que ya se identificaron alguna vez (ver
// src/lib/agente.ts) — hace falta para poder traspasar una conversación a alguien en
// concreto: necesitamos el `id` REAL que ese agente manda en sus propios pedidos (el que
// genera su navegador y guarda en localStorage), no un id inventado a partir de un
// nombre tipeado a mano, porque si no coincide, esa persona no va a poder responder
// después (ver ARCHITECTURE.md §20). Se resetea si se reinicia el server — mismo
// criterio que el resto del estado de las Fases 1–2 (no es un problema real: en la
// Fase 6 esto lo reemplaza el directorio de usuarios de GHL).
const agentes = new Map<string, Agente>()

export function registrarAgente(agente: Agente) {
  agentes.set(agente.id, agente)
}

export function listarAgentesConocidos(): Agente[] {
  return [...agentes.values()].sort((a, b) => a.nombre.localeCompare(b.nombre))
}
