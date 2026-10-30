/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

/**
 * El backend (`npm run serve`) no envía cabeceras CORS y escucha solo en
 * 127.0.0.1. El frontend habla con él a través de este proxy, bajo el prefijo
 * `/api`, que se elimina al reenviar. El prefijo evita que las rutas de la SPA
 * (`/sessions/:id`, `/executions/:id`) choquen con las de la API al recargar.
 *
 * `SAIKI_API_URL` (entorno o `.env.local`) cambia el destino si el backend usa
 * otro puerto (`SAIKI_API_PORT`).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "SAIKI_");
  const apiProxy: Record<string, ProxyOptions> = {
    "/api": {
      target: env.SAIKI_API_URL ?? "http://127.0.0.1:4123",
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ""),
      // Si el backend cae, el proxy deja abierta la respuesta SSE hacia el
      // navegador (verificado: con `kill -9` el stream directo se corta y el
      // proxiado no). Cerrarla permite que EventSource detecte el corte y reconecte.
      configure: (proxy) => {
        proxy.on("proxyRes", (proxyRes, _req, res) => {
          if (!String(proxyRes.headers["content-type"] ?? "").startsWith("text/event-stream")) return;
          proxyRes.on("close", () => {
            if (!res.writableEnded) res.destroy();
          });
        });
      },
    },
  };
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy: apiProxy },
    preview: { port: 4173, strictPort: true, proxy: apiProxy },
    test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
    },
  };
});
