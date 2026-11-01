# saiki-ia

Orquestador personal de agentes IA construido con **LangGraph.js** y **TypeScript**.

Proyecto de aprendizaje que avanza por fases con KISS (sin sobreingeniería):

- **Fase 1** — fundamentos de LangGraph: grafo secuencial que simula un flujo de
  desarrollo (analyze → develop → review).
- **Fase 2** — rutas condicionales: bucle de corrección con límite de reintentos.
- **Fase 3** — arquitectura de agentes: contrato `AgentAdapter` e inyección de
  dependencias para conectar agentes reales en el futuro (aún todos simulados).

No usa modelos de IA, API keys ni procesos externos todavía.

## Flujo del grafo

```
START → analyzeTask → developTask → reviewTask → (condicional)
   ├─ aprobado             → finishTask → END   (status = "approved")
   ├─ rechazado + quedan    → developTask        (bucle de corrección)
   └─ rechazado + sin cupo  → failTask   → END   (status = "failed")
```

Los nodos usan nombres de acción (`*Task`) porque en LangGraph un nodo no puede
llamarse igual que un campo del estado (el estado tiene el campo `review`).

## Arquitectura de agentes (Fase 3)

Los nodos no conocen a Kiro/Claude/Codex: dependen de la abstracción
`AgentAdapter`. Conectar un agente real = escribir una clase que implemente ese
contrato, sin tocar los nodos ni el grafo.

```
src/agents/
├── types.ts        # contrato AgentAdapter + AgentResult + AgentRole
└── mock-agent.ts   # MockAgentAdapter (implementación simulada, por defecto)
```

## Requisitos

- **Node.js 20+** (probado con Node 22 vía nvm).
- npm.

Incluye un `.npmrc` local que fuerza el registry público de npm, por si tu npm
global apunta a otro registry (p. ej. un Artifactory corporativo).

## Instalación

```bash
npm install
```

## Datos locales

El backend (`npm run serve`) guarda su estado en `./.saiki/`. Para usar otra
ubicación, define `SAIKI_DATA_DIR` con una ruta absoluta; el traslado de datos
existentes es manual: [docs/API.md §1.1](docs/API.md#11-directorio-de-datos).
`SAIKI_CONTEXT_REFRESH_MS` (ms, por defecto 30 000) limita cuánto espera una
ejecución a que se actualice el contexto del proyecto antes del análisis técnico.
`SAIKI_KIRO_TIMEOUT_MS` (entero positivo en ms, por defecto 60 000) es el tiempo
máximo de cada llamada a Kiro CLI (análisis de HU, análisis técnico y
revisiones); un valor inválido detiene el arranque con un mensaje claro.
`SAIKI_CLAUDE_TIMEOUT_MS` (mismo criterio, por defecto 120 000) es el tiempo
máximo de cada llamada a Claude Code en el desarrollo. Ambos valores se muestran
al arrancar.

## Ejecutar el grafo

```bash
npm start
```

## Ejecutar las pruebas

```bash
npm test
```

## Otros scripts

```bash
npm run typecheck   # chequeo de tipos sin emitir JS
npm run dev         # ejecuta el grafo en modo watch
npm run test:watch  # tests en modo watch
```

## Estructura del proyecto

```
.
├── package.json         # dependencias (pineadas) y scripts
├── tsconfig.json        # configuración de TypeScript (ESM, strict)
├── vitest.config.ts     # configuración de pruebas
├── .npmrc               # fuerza el registry público de npm (solo este proyecto)
├── .gitignore
├── docs/PROJECT_MEMORY.md
└── src/
    ├── agents/
    │   ├── types.ts         # contrato AgentAdapter
    │   ├── mock-agent.ts     # adaptador simulado
    │   └── mock-agent.test.ts
    ├── state.ts         # estado tipado compartido (Annotation.Root) + reducers
    ├── nodes.ts         # nodos (fábricas que reciben el AgentAdapter)
    ├── graph.ts         # construcción del grafo + arista condicional + compile()
    ├── index.ts         # punto de entrada: ejecuta escenarios e imprime
    └── graph.test.ts    # pruebas del flujo (Fases 1 y 2)
```

## Dependencias clave

| Paquete                | Versión  | Para qué                          |
| ---------------------- | -------- | --------------------------------- |
| `@langchain/langgraph` | 1.5.3    | API Graph (StateGraph, START/END) |
| `@langchain/core`      | 1.3.2    | peer dependency de LangGraph      |
| `tsx`                  | 4.23.15  | ejecutar TypeScript directo       |
| `vitest`               | 5.0.5    | pruebas                           |
| `typescript`           | 5.9.3    | tipos / typecheck                 |

## Alcance actual (lo que NO hay todavía)

Sin frontend, sin servidor HTTP/WebSocket, sin Godot, sin agentes CLI reales,
sin modelos, sin base de datos ni memoria semántica, sin human-in-the-loop ni
sistema de permisos. Todo eso llega en fases posteriores.
