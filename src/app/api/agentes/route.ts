import { NextRequest, NextResponse } from 'next/server'
import { agenteActual } from '@/lib/agente'
import { listarAgentesConocidos } from '@/lib/agentesConocidos'

// Lista de agentes que ya se identificaron alguna vez, para poder elegir a quién
// traspasarle una conversación (ver ARCHITECTURE.md §20). Llamar a esta ruta también
// registra al agente que pide, de paso — así con solo tener el inbox abierto ya
// aparecés como destino posible para los demás.
export async function GET(request: NextRequest) {
  await agenteActual(request)
  return NextResponse.json({ agentes: listarAgentesConocidos() })
}
