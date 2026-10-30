import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";
import { EventStore } from "./event-store.js";
import type { SaikiEvent, NewEvent } from "./event-types.js";

function ev(executionId: string | undefined, type: SaikiEvent["type"], extra: Partial<NewEvent> = {}): NewEvent {
  return {
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    type,
    executionId,
    sessionId: extra.sessionId,
    timestamp: new Date().toISOString(),
    data: (extra.data ?? { phase: "x", status: "y" }) as never,
  };
}

describe("Fase 20: EventBus (aislamiento)", () => {
  it("13. un suscriptor defectuoso no afecta a los demás ni al Core", () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.onSubscriberError = (e) => errors.push(e);
    const received: string[] = [];
    bus.subscribe(() => { throw new Error("suscriptor roto"); });
    bus.subscribe((e) => received.push(e.type));
    // publish NO debe lanzar pese al suscriptor roto.
    expect(() => bus.publish({ ...ev("x", "execution.started"), seq: 1 } as SaikiEvent)).not.toThrow();
    expect(received).toEqual(["execution.started"]); // el sano recibió
    expect(errors.length).toBe(1); // el fallo se capturó
  });

  it("subscribe devuelve unsubscribe funcional", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe((e) => got.push(e.type));
    bus.publish({ ...ev("x", "stage.started"), seq: 1 } as SaikiEvent);
    off();
    bus.publish({ ...ev("x", "stage.completed"), seq: 2 } as SaikiEvent);
    expect(got).toEqual(["stage.started"]);
  });
});

describe("Fase 20: EventStore (seq + reconexión)", () => {
  it("11+asigna seq incremental por ejecución", () => {
    const store = new EventStore(":memory:");
    const a1 = store.append(ev("exec-a", "execution.started"));
    const a2 = store.append(ev("exec-a", "stage.started"));
    const b1 = store.append(ev("exec-b", "execution.started"));
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1); // secuencia independiente por ejecución
    store.close();
  });

  it("getSince devuelve solo los posteriores (reconexión)", () => {
    const store = new EventStore(":memory:");
    store.append(ev("e", "execution.started"));
    store.append(ev("e", "stage.started"));
    store.append(ev("e", "stage.completed"));
    const after1 = store.getSince("e", 1);
    expect(after1.map((x) => x.seq)).toEqual([2, 3]);
    store.close();
  });

  it("eventos sin executionId no se persisten (seq 0)", () => {
    const store = new EventStore(":memory:");
    const r = store.append(ev(undefined, "knowledge.proposed", { data: { docId: "d", title: "t", category: "research" } as never }));
    expect(r.seq).toBe(0);
    store.close();
  });

  it("retención: conserva como máximo N por ejecución", () => {
    const store = new EventStore(":memory:", { maxPerExecution: 3 });
    for (let i = 0; i < 6; i++) store.append(ev("e", "stage.started"));
    const all = store.getAll("e");
    expect(all.length).toBe(3);
    // Conserva los MÁS RECIENTES (seq 4,5,6).
    expect(all.map((x) => x.seq)).toEqual([4, 5, 6]);
    expect(store.earliestSeq("e")).toBe(4);
    store.close();
  });
});
