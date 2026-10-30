import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

/**
 * Checkpointer persistente (Fase 7).
 *
 * Sustituye al MemorySaver (en memoria, se pierde al reiniciar) por un
 * checkpointer SQLite durable, verificado compatible con langgraph 1.5.3.
 *
 * Decision KISS: SQLite local via @langchain/langgraph-checkpoint-sqlite. No se
 * usan servicios externos. La ubicacion del archivo es EXPLICITA y configurable.
 */

/** Ubicacion por defecto del almacen persistente (excluida de git). */
export const DEFAULT_DB_PATH = ".saiki/checkpoints.sqlite";

/**
 * Crea un checkpointer SQLite persistente en `dbPath`. Crea el directorio
 * contenedor si no existe. El mismo archivo entre ejecuciones = estado durable.
 */
export function createSqliteCheckpointer(dbPath: string = DEFAULT_DB_PATH): BaseCheckpointSaver {
  mkdirSync(dirname(dbPath), { recursive: true });
  // API verificada: SqliteSaver.fromConnString(path).
  return SqliteSaver.fromConnString(dbPath);
}

/**
 * Crea un checkpointer en memoria (MemorySaver). Util SOLO para tests que no
 * necesitan durabilidad entre procesos. NO usar en produccion (no sobrevive a
 * reinicios).
 */
export function createMemoryCheckpointer(): BaseCheckpointSaver {
  return new MemorySaver();
}
