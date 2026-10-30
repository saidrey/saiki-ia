import { describe, it, expect } from "vitest";
import { LlmModerator, ModeratorEngineError, parseClassification } from "./llm-moderator.js";
import type { ConversationEngine, ConversationRequest, ConversationResult } from "./conversation-engine.js";
import { createModeratorSession, addUserTurn, addModeratorTurn } from "./session.js";
import type { RichClassification } from "./moderator-types.js";
import { createDelegatedTask } from "./delegation.js";

/**
 * Motor conversacional FALSO y determinista. Devuelve respuestas predefinidas
 * según el contenido del prompt, sin llamar a ningún CLI. Permite probar el
 * moderador sin Claude real.
 */
class FakeEngine implements ConversationEngine {
  readonly name = "fake-engine";
  calls: ConversationRequest[] = [];
  constructor(private readonly responder: (req: ConversationRequest) => ConversationResult) {}
  async complete(req: ConversationRequest): Promise<ConversationResult> {
    this.calls.push(req);
    return this.responder(req);
  }
}

/** Construye un JSON de clasificación válido. */
function classifyJson(c: Partial<RichClassification> & { intent: RichClassification["intent"] }): string {
  return JSON.stringify({
    intent: c.intent,
    confidence: c.confidence ?? 0.8,
    reason: c.reason ?? "motivo",
    missingInfo: c.missingInfo ?? [],
    recommendedAction: c.recommendedAction ?? "reply",
    proposedFlow: c.proposedFlow ?? "flujo",
    clarifyingQuestion: c.clarifyingQuestion ?? "",
  });
}

/**
 * Extrae del prompt SOLO el mensaje actual del usuario (tras el marcador que
 * pone el moderador), para no confundir las palabras clave del esquema con las
 * del mensaje real.
 */
function userMessageOf(prompt: string): string {
  const marker = "Mensaje actual del usuario:";
  const idx = prompt.indexOf(marker);
  return (idx === -1 ? prompt : prompt.slice(idx + marker.length)).toLowerCase();
}

/** Engine que clasifica según palabra clave del MENSAJE y, si se pide, responde. */
function routingEngine(): FakeEngine {
  return new FakeEngine((req) => {
    const isClassify = !!req.systemHint && req.systemHint.includes("Clasificas");
    if (isClassify) {
      const msg = userMessageOf(req.prompt);
      if (msg.includes("implementa") || msg.includes("crea ")) return { ok: true, text: classifyJson({ intent: "development", confidence: 0.9 }) };
      if (msg.includes("investiga") || msg.includes("compara")) return { ok: true, text: classifyJson({ intent: "assistance" }) };
      if (msg.includes("no sé") || msg.includes("eso")) return { ok: true, text: classifyJson({ intent: "clarification", clarifyingQuestion: "¿A qué te refieres exactamente?" }) };
      return { ok: true, text: classifyJson({ intent: "conversation" }) };
    }
    // Si no, es una petición de redacción de respuesta conversacional.
    return { ok: true, text: "Respuesta redactada por el moderador." };
  });
}

const session = () => createModeratorSession("s");

describe("Fase 16: LlmModerator (conversacional)", () => {
  it("1. consulta técnica -> conversation (no desarrollo)", async () => {
    const m = new LlmModerator(routingEngine());
    const d = await m.respond("¿cómo funciona el checkpointer?", session());
    expect(d.classification.intent).toBe("conversation");
    expect(d.startDevelopment).toBe(false);
    expect(d.delegateAssistance).toBe(false);
    expect(d.reply).toBeTruthy();
  });

  it("2. investigación -> assistance (delegar)", async () => {
    const m = new LlmModerator(routingEngine());
    const d = await m.respond("investiga opciones de colas", session());
    expect(d.classification.intent).toBe("assistance");
    expect(d.delegateAssistance).toBe(true);
    expect(d.startDevelopment).toBe(false);
  });

  it("3. solicitud de desarrollo -> development (enviar al grafo)", async () => {
    const m = new LlmModerator(routingEngine());
    const d = await m.respond("implementa un util de suma", session());
    expect(d.classification.intent).toBe("development");
    expect(d.startDevelopment).toBe(true);
  });

  it("4. mensaje ambiguo -> clarification con pregunta", async () => {
    const m = new LlmModerator(routingEngine());
    const d = await m.respond("arregla eso que no sé", session());
    expect(d.classification.intent).toBe("clarification");
    expect(d.clarifyingQuestion).toBeTruthy();
    expect(d.startDevelopment).toBe(false);
    expect(d.delegateAssistance).toBe(false);
  });

  it("5. aclaración permite continuar con la intención correcta", async () => {
    // Engine que mira el HISTORIAL: si ya se pidió aclaración y ahora llega un
    // mensaje con 'implementa', clasifica development.
    const engine = new FakeEngine((req) => {
      const msg = userMessageOf(req.prompt);
      if (msg.includes("implementa")) return { ok: true, text: classifyJson({ intent: "development" }) };
      return { ok: true, text: classifyJson({ intent: "clarification", clarifyingQuestion: "¿qué implemento?" }) };
    });
    const m = new LlmModerator(engine);
    let s = session();
    const d1 = await m.respond("hazlo", s);
    expect(d1.classification.intent).toBe("clarification");
    s = addUserTurn(s, "hazlo");
    s = addModeratorTurn(s, d1.clarifyingQuestion!);
    const d2 = await m.respond("implementa un util de suma", s);
    expect(d2.classification.intent).toBe("development");
  });

  it("6. referencia a contexto anterior: el historial se incluye en el prompt", async () => {
    const engine = routingEngine();
    const m = new LlmModerator(engine);
    let s = session();
    s = addUserTurn(s, "estuve viendo el router de agentes");
    s = addModeratorTurn(s, "ok, ¿qué necesitas?");
    await m.respond("¿y eso cómo se prueba?", s);
    // El prompt de clasificación incluyó el historial (contexto).
    const classifyCall = engine.calls.find((c) => c.systemHint?.includes("Clasificas"));
    expect(classifyCall?.prompt).toContain("router de agentes");
  });

  it("7. corrección del usuario: el nuevo mensaje reclasifica", async () => {
    // Primero development, luego el usuario corrige a 'solo investiga'.
    const engine = new FakeEngine((req) => {
      const msg = userMessageOf(req.prompt);
      if (msg.includes("mejor solo investiga")) return { ok: true, text: classifyJson({ intent: "assistance" }) };
      if (msg.includes("implementa")) return { ok: true, text: classifyJson({ intent: "development" }) };
      return { ok: true, text: classifyJson({ intent: "conversation" }) };
    });
    const m = new LlmModerator(engine);
    let s = session();
    const d1 = await m.respond("implementa un login", s);
    expect(d1.classification.intent).toBe("development");
    s = addUserTurn(s, "implementa un login");
    const d2 = await m.respond("espera, mejor solo investiga opciones", s);
    expect(d2.classification.intent).toBe("assistance");
  });

  it("8. error del proveedor -> ModeratorEngineError explícito (sin falso éxito)", async () => {
    const engine = new FakeEngine(() => ({ ok: false, error: "claude no disponible (ENOENT)" }));
    const m = new LlmModerator(engine);
    await expect(m.respond("hola", session())).rejects.toBeInstanceOf(ModeratorEngineError);
  });

  it("8b. JSON inválido del modelo -> error explícito (no se simula)", async () => {
    const engine = new FakeEngine(() => ({ ok: true, text: "esto no es JSON" }));
    const m = new LlmModerator(engine);
    await expect(m.classifyAsync("x", session())).rejects.toBeInstanceOf(ModeratorEngineError);
  });

  it("9. el moderador NO tiene capacidad de modificar ni aprobar", () => {
    const m = new LlmModerator(routingEngine());
    // El contrato no expone ningún método de escritura/aprobación.
    expect((m as unknown as Record<string, unknown>).apply).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).approve).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).submitApproval).toBeUndefined();
  });

  it("síntesis de asistencia: diferencia hecho/hipótesis y conserva referencia; no inventa si falló", async () => {
    const engine = new FakeEngine(() => ({ ok: true, text: "HECHOS: A. HIPÓTESIS: B. RECOMENDACIÓN: C." }));
    const m = new LlmModerator(engine);
    const ok = createDelegatedTask({ id: "t1", request: "r", goal: "g", agentRole: "assistant", runtime: "opencode", requiredCapabilities: [], grantedCapabilities: [] });
    const done = { ...ok, status: "succeeded" as const, result: "datos de la investigación" };
    const synth = await m.synthesizeAssistance(done);
    expect(synth).toContain("HECHOS");
    expect(synth).toContain("t1"); // conserva referencia

    // Si la tarea falló, NO inventa resultado.
    const failed = { ...ok, status: "failed" as const };
    const synth2 = await m.synthesizeAssistance(failed);
    expect(synth2).toContain("no produjo");
  });

  it("confianza alta NO cambia las reglas: development sigue requiriendo el grafo", async () => {
    // Aun con confidence 0.99, el moderador solo MARCA startDevelopment; no
    // ejecuta nada (eso lo valida la integración con el Core en saiki-core.test).
    const engine = new FakeEngine(() => ({ ok: true, text: classifyJson({ intent: "development", confidence: 0.99 }) }));
    const m = new LlmModerator(engine);
    const d = await m.respond("implementa algo", session());
    expect(d.startDevelopment).toBe(true);
    // No hay ningún efecto secundario: respond solo devuelve la decisión.
  });
});

describe("Fase 16: parseClassification (robustez)", () => {
  it("extrae JSON envuelto en texto/markdown", () => {
    const wrapped = "Claro:\n```json\n" + classifyJson({ intent: "assistance" }) + "\n```";
    const parsed = parseClassification(wrapped);
    expect(parsed?.intent).toBe("assistance");
  });
  it("rechaza intent inválido", () => {
    expect(parseClassification(JSON.stringify({ intent: "otro" }))).toBeNull();
  });
  it("clampa la confianza a [0,1]", () => {
    const parsed = parseClassification(classifyJson({ intent: "conversation", confidence: 5 }));
    expect(parsed?.confidence).toBe(1);
  });
});
