# Jev — interfaz web de Saiki-IA

Sub-proyecto independiente (no importa nada de `../src`). Consume solo la API
REST + SSE del backend (`docs/API.md`, `docs/EVENTS.md`). Plan y decisiones:
`docs/FRONTEND_PROPOSAL.md`.

## Ejecutar

Requiere Node 22 (`nvm use 22`). Dos terminales:

```bash
# 1. Backend, desde la raíz del repo
npm run serve            # http://127.0.0.1:4123

# 2. Frontend, desde web/
npm install
npm run dev              # http://localhost:5173
```

Si el backend usa otro puerto (`SAIKI_API_PORT`), indícalo al frontend con
`SAIKI_API_URL=http://127.0.0.1:<puerto> npm run dev` (o en `web/.env.local`).

## Proxy `/api`

El backend no envía cabeceras CORS. Vite reenvía `/api/*` a la API quitando el
prefijo (`/api/health` → `/health`), en `npm run dev` y en `npm run preview`.
El prefijo evita que recargar una ruta de la SPA (`/sessions/:id`) devuelva JSON
de la API. El SSE (`/api/executions/:id/events`) pasa por el mismo proxy.
Servir el build en producción detrás del mismo origen queda fuera de alcance.

El proxy cierra la respuesta SSE hacia el navegador cuando el backend corta la
suya (sin esto, una caída del backend dejaba el stream abierto y la interfaz no
se enteraba). Los latidos `: ping` del backend no son visibles para
`EventSource`: el estado de conexión se basa en `EventSource` y en ese cierre.

## Scripts

- `npm run typecheck` — TypeScript sin emitir.
- `npm test` — Vitest (el cliente HTTP se prueba contra un servidor HTTP real local).
- `npm run build` — typecheck + build de producción en `dist/`.

## Reglas

- La API es la fuente de verdad: sin datos, estados ni eventos simulados.
- No se envía `actorId`; las aprobaciones reenvían el hash recibido tal cual.
- Lo que el backend no da se muestra como "No disponible", con su motivo.
- Dependencias fijadas a versiones exactas; `.npmrc` fuerza el registry público.
