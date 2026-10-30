# saiki-ia — instrucciones para Claude Code

Orquestador personal de agentes IA (LangGraph.js + TypeScript). Contexto y
memoria del proyecto: `docs/PROJECT_MEMORY.md` y `.kiro/steering/project-context.md`.

## Límites vigentes

- Jev (Fase 21) está aprobado y se implementa por pasos (plan de 8 pasos de
  `docs/FRONTEND_PROPOSAL.md`). Presentar cada paso para revisión antes del
  siguiente. Sin datos simulados: la API es la fuente de verdad.
- Frontend aprobado (2026-10-30): Vite + React + TypeScript en `web/`, React
  Router, TanStack Query, CSS Modules + variables CSS, EventSource. Sin Tailwind
  ni librerías de componentes. No añadir dependencias fuera de esa lista sin
  consultar. Plan y reglas: `docs/FRONTEND_PROPOSAL.md`.
- La UI consume el backend existente y no lo modifica: REST en `docs/API.md`,
  SSE en `docs/EVENTS.md`, fachada `JevCorePort`. No cambiar contratos REST/SSE,
  `src/core/` ni el resto del backend como parte del trabajo de UI.

## Skills de UI/UX y frontend

Instaladas en `.claude/skills/` (procedencia y versiones:
`.claude/skills/README.md`). Usarlas solo en tareas de interfaz; nunca en
trabajo de backend, Core, grafo o API.

Cada skill tiene un rol; elegir la mínima necesaria según la tarea:

| Tarea | Skill(s) |
|---|---|
| Definir dirección visual, tokens (color, tipografía, layout) de una pantalla o del sistema | `ui-ux-pro-max` (datos y reglas UX) → `frontend-design` (decisión estética final) |
| Construir o rehacer UI | `frontend-design`; consultar `ui-ux-pro-max` solo para dudas concretas (`--domain`/`--stack`) |
| Corregir un detalle puntual de UX/estilo | `ui-ux-pro-max` con un `--domain` |
| Calidad técnica del código React de `web/` | `vercel-react-best-practices` (solo reglas de cliente; ignorar las de Next.js/servidor) |
| Validar accesibilidad de una página en ejecución | `accessibility-scan` (automático) y, si hace falta, `accessibility-inspect` (manual) |
| Corregir hallazgos de accesibilidad | `accessibility-fix` |
| Comprobar regresiones de accesibilidad de un cambio | `accessibility-diff` |
| Auditoría WCAG completa del producto | `accessibility-audit` (solo a petición) |

### Precedencia (para evitar contradicciones)

1. Decisiones explícitas del usuario y el design system aprobado del proyecto.
2. Accesibilidad: requisitos WCAG 2.2 AA. AccessLint es la autoridad para
   **validar**; las reglas de accesibilidad de `ui-ux-pro-max` sirven para
   **prevenir** durante el diseño.
3. Reglas UX de `ui-ux-pro-max` (interacción, formularios, navegación, rendimiento).
4. Dirección estética de `frontend-design`: los catálogos de estilos/paletas de
   `ui-ux-pro-max` son referencia, no plantilla; `frontend-design` decide la
   identidad visual y evita resultados genéricos.

Saiki-IA es una herramienta local de un solo usuario para orquestar agentes,
revisar propuestas y aprobar acciones: priorizar claridad del estado, trazabilidad
y aprobaciones humanas seguras por encima de lo decorativo.

### Notas de uso

- **ui-ux-pro-max**: su `SKILL.md` usa `${CLAUDE_PLUGIN_ROOT}`, que no existe en
  esta instalación. Ejecutar desde la raíz del repo:
  `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<consulta>" --domain <dominio>`.
  No usar `--persist` (escribe `design-system/`) sin aprobación del usuario.
- **AccessLint**: requiere una página en ejecución. Ejecuta `npx -y
  @accesslint/cli@latest` y `@accesslint/chrome@latest` (descarga paquetes y
  lanza Chrome): avisar al usuario antes de la primera ejecución. No hay servidor
  MCP de AccessLint instalado; ignorar las herramientas
  `mcp__plugin_accesslint_accesslint__*` y usar la CLI. Las referencias
  `accesslint:<skill>` equivalen a la skill local `<skill>`.
