import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { CoreStore } from "../core/core-store.js";
import { ContextStore } from "../context/context-store.js";
import { EventStore } from "../events/event-store.js";
import { KnowledgeStore } from "../knowledge/kb-store.js";
import { createSqliteCheckpointer } from "./checkpointer.js";

/**
 * (Project Context, T4b) Directorio de datos operativos de Saiki-IA.
 *
 * Único punto que decide dónde viven las bases de datos del backend:
 * `SAIKI_DATA_DIR` (ruta absoluta) o, si no está definida, `.saiki` relativo al
 * directorio de arranque (comportamiento anterior). Nunca mueve, copia ni borra
 * datos: si los datos siguen en la ubicación anterior, solo avisa.
 */

export const DATA_DIR_ENV = "SAIKI_DATA_DIR";
export const DEFAULT_DATA_DIR = ".saiki";

/** Archivo de cada base de datos dentro del directorio de datos. */
export const DATA_FILES = {
  core: "core.sqlite",
  checkpoints: "checkpoints.sqlite",
  events: "events.sqlite",
  knowledge: "knowledge.sqlite",
  context: "context.sqlite",
} as const;

export type DataFile = keyof typeof DATA_FILES;

export interface DataPaths {
  /** Directorio de datos, absoluto y normalizado. */
  dir: string;
  /** De dónde sale: la variable de entorno o el valor predeterminado. */
  source: "env" | "default";
  /** Ruta absoluta de cada base de datos. */
  files: Record<DataFile, string>;
}

export type DataPathsResolution = { ok: true; paths: DataPaths } | { ok: false; message: string };

/** Resuelve el directorio de datos. Solo calcula rutas: no toca el disco. */
export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): DataPathsResolution {
  const raw = env[DATA_DIR_ENV];
  const fromEnv = raw !== undefined && raw !== "";
  if (fromEnv && !isAbsolute(raw)) {
    return { ok: false, message: `${DATA_DIR_ENV} debe ser una ruta absoluta (recibido "${raw}").` };
  }
  const dir = fromEnv ? resolve(raw) : resolve(cwd, DEFAULT_DATA_DIR);
  const files = Object.fromEntries(Object.entries(DATA_FILES).map(([k, f]) => [k, join(dir, f)])) as Record<DataFile, string>;
  return { ok: true, paths: { dir, source: fromEnv ? "env" : "default", files } };
}

function hasDatabases(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".sqlite"));
  } catch {
    return false;
  }
}

/**
 * Aviso de migración manual: `SAIKI_DATA_DIR` apunta a un directorio sin bases
 * de datos mientras la ubicación anterior (`<cwd>/.saiki`) sí las tiene. Debe
 * llamarse antes de abrir los almacenes (que crean el directorio). Solo lee.
 */
export function legacyDataNotice(paths: DataPaths, cwd: string = process.cwd()): string | null {
  const legacy = resolve(cwd, DEFAULT_DATA_DIR);
  if (paths.source !== "env" || paths.dir === legacy) return null;
  if (!hasDatabases(legacy) || hasDatabases(paths.dir)) return null;
  return [
    `${DATA_DIR_ENV} apunta a ${paths.dir}, que no tiene datos, pero hay datos en la ubicación anterior ${legacy}.`,
    "Saiki-IA arranca vacío y no mueve nada. Para conservar sesiones, ejecuciones y conocimiento:",
    "  1. Detén el backend.",
    `  2. Mueve los archivos *.sqlite* de ${legacy} a ${paths.dir}.`,
    "  3. Arranca de nuevo con la misma variable.",
    "Detalle: docs/API.md, sección «Directorio de datos».",
  ].join("\n");
}

export interface DataStores {
  coreStore: CoreStore;
  checkpointer: BaseCheckpointSaver;
  eventStore: EventStore;
  knowledge: KnowledgeStore;
  /** (Project Context) Índice y snapshots de los proyectos. */
  contextStore: ContextStore;
}

/** Abre las bases de datos del backend en el directorio resuelto (crea el directorio si falta). */
export function openDataStores(paths: DataPaths): DataStores {
  return {
    coreStore: new CoreStore(paths.files.core),
    checkpointer: createSqliteCheckpointer(paths.files.checkpoints),
    eventStore: new EventStore(paths.files.events),
    knowledge: new KnowledgeStore(paths.files.knowledge),
    contextStore: new ContextStore(paths.files.context),
  };
}
