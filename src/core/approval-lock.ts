/**
 * Lock de exclusión mutua POR CLAVE (Fase 19).
 *
 * Serializa las operaciones que comparten la misma clave (p. ej. un `threadId`
 * de ejecución), SIN bloquear claves distintas. Es un mutex por clave, no global:
 * dos ejecuciones diferentes avanzan en paralelo; dos resoluciones de la MISMA
 * ejecución se encolan y se ejecutan una tras otra.
 *
 * Implementación KISS: una cadena de promesas por clave. `runExclusive` encadena
 * su operación tras la anterior de esa clave y libera siempre (incluso ante
 * error) para no dejar la clave bloqueada. Un contador por clave permite limpiar
 * la entrada cuando ya no quedan operaciones pendientes.
 */
export class KeyedMutex {
  private readonly tail = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, number>();

  /**
   * Ejecuta `fn` en exclusión mutua para `key`. Devuelve lo que devuelva `fn`.
   * Si `fn` lanza, el error se propaga al llamador y la cadena igualmente avanza
   * (no queda bloqueada).
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);

    const previous = this.tail.get(key) ?? Promise.resolve();
    // Encadena: la operación propia corre cuando termine la anterior. Se ignora
    // el resultado/el error de la anterior para no romper la cadena.
    const run = previous.catch(() => undefined).then(() => fn());
    this.tail.set(key, run.catch(() => undefined));

    try {
      return await run;
    } finally {
      const remaining = (this.waiting.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.waiting.delete(key);
        this.tail.delete(key);
      } else {
        this.waiting.set(key, remaining);
      }
    }
  }
}
