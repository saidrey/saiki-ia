/**
 * Declaración de tipos MÍNIMA para `better-sqlite3` (Fase 14).
 *
 * El paquete ya está presente como dependencia transitiva del checkpointer,
 * pero no trae tipos y `@types/better-sqlite3` no está instalado. Para NO añadir
 * una dependencia nueva (regla del proyecto), declaramos aquí solo la superficie
 * que usamos: `new Database(path)`, `exec`, `prepare(...).run/get/all`, `pragma`,
 * `close`. Es intencionalmente parcial.
 */
declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    pragma(source: string): unknown;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string): Database;
    (filename: string): Database;
  }

  namespace Database {
    type Database = import("better-sqlite3").Database;
  }

  const Database: DatabaseConstructor;
  export = Database;
}
