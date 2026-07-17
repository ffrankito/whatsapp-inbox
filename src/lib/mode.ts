// Orden de prioridad de los modos del roadmap (ver ARCHITECTURE.md §14):
// DEMO_MODE (Fase 1, datos de mentira) > STANDALONE_MODE (Fase 2, Kapso real sin GHL)
// > modo real (GHL conectado, Fase 6 en adelante).
export const DEMO_MODE = process.env.DEMO_MODE === 'true'
export const STANDALONE_MODE = !DEMO_MODE && process.env.STANDALONE_MODE === 'true'
