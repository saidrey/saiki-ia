import type { SaikiEvent } from "./event-types.js";

/**
 * Bus de eventos interno (Fase 20): sencillo y DESACOPLADO.
 *
 * - Los componentes del Core publican con `publish`.
 * - Los consumidores (p. ej. el endpoint SSE) se suscriben con `subscribe` y
 *   reciben una función para desuscribirse.
 * - AISLAMIENTO: si un suscriptor lanza, el error se captura y NO detiene el
 *   Core ni afecta a los demás suscriptores.
 * - La publicación NO bloquea: se entrega a cada suscriptor dentro de un
 *   try/catch; no espera trabajo asíncrono del suscriptor.
 *
 * Sin dependencias externas. No sustituye la persistencia (el EventStore guarda;
 * el bus solo distribuye en vivo).
 */

export type EventSubscriber = (event: SaikiEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>();
  /** Hook opcional para registrar errores de suscriptores (tests/diagnóstico). */
  onSubscriberError?: (error: unknown) => void;

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Nº de suscriptores activos (diagnóstico). */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Publica un evento a todos los suscriptores. Un suscriptor defectuoso no
   * interrumpe la publicación a los demás ni propaga el error al Core.
   */
  publish(event: SaikiEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (e) {
        // Aislamiento: el fallo de un suscriptor no afecta al Core ni a otros.
        if (this.onSubscriberError) {
          try {
            this.onSubscriberError(e);
          } catch {
            /* nunca propagar desde el hook de error */
          }
        }
      }
    }
  }
}
