import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build pensado para correr en Docker (ver Dockerfile) — genera un server.js mínimo
  // sin depender de node_modules completo adentro de la imagen final.
  output: "standalone",
};

export default nextConfig;
