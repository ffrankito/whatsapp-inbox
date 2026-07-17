# WhatsApp Inbox — Security24 (área comercial)

Inbox de WhatsApp propio, embebido dentro de GoHighLevel vía Custom Menu Link, para los
3 números (Dealers, Abonados, App Full Control). Ver el diseño completo en
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Preview visual (maqueta, sin lógica real): [`docs/preview.html`](docs/preview.html).

## Desarrollo

```bash
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000).

## Variables de entorno

Ver `.env.example` — hay que completar credenciales de GHL (Marketplace App) y de Kapso
(los 3 números) antes de que el flujo end-to-end funcione. Detalle de cada una en
`docs/ARCHITECTURE.md` §8.
