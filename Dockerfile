# WhatsApp Inbox — Security24
# Build multi-stage pensado para next.config.ts con output: "standalone"
# (ver docs/ARCHITECTURE.md §7.1)

FROM node:22-alpine AS deps
WORKDIR /app
# La imagen trae npm 10.x; el lockfile se genera con la versión de npm de quien lo edite.
# Versiones 11.x distintas resuelven distinto las deps opcionales de WASM (@emnapi/*) y
# npm ci falla con "lockfile desincronizado" aunque el lock esté bien — por eso se fija
# la misma versión exacta que usa quien edita el proyecto, no solo el major "11".
RUN npm install -g npm@11.6.1
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js necesita estas en build time si algún día se leen desde código de cliente;
# hoy no hay NEXT_PUBLIC_*, se deja el ARG por si hace falta más adelante.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# No correr como root adentro del contenedor (ver ARCHITECTURE.md §15, hardening).
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
