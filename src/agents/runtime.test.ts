import { describe, it, expect } from "vitest";
import {
  RuntimeRegistry,
  createDefaultRuntimeRegistry,
  defaultRuntimeDescriptors,
  type RuntimeId,
} from "./runtime.js";
import {
  PermissionGrant,
  checkPermissions,
  type Capability,
} from "./capabilities.js";
import { MapAgentRouter } from "./router.js";
import { MockAgentAdapter } from "./mock-agent.js";
import { KiroCliAdapter } from "./kiro-cli-agent.js";
import { ClaudeCliAdapter } from "./claude-cli-agent.js";
import { OpenCodeCliAdapter } from "./opencode-cli-agent.js";
import type { AgentAdapter, AgentRole } from "./types.js";

describe("Fase 14: runtimes, capabilities y router (arquitectura multi-runtime)", () => {
  it("1. los roles NO están acoplados a un proveedor (mismo rol, runtimes distintos)", async () => {
    // El rol 'develop' puede ejecutarse con Claude o, en principio, con otro
    // runtime. Lo demostramos resolviéndolo contra adaptadores distintos SIN
    // cambiar el rol ni el contrato.
    const claudeLike: AgentAdapter = { name: "claude", async run(r) { return { status: "success", output: "c", role: r.role }; } };
    const kiroLike: AgentAdapter = { name: "kiro", async run(r) { return { status: "success", output: "k", role: r.role }; } };

    const routerA = new MapAgentRouter({ analyze: kiroLike, develop: claudeLike, review: kiroLike });
    const routerB = new MapAgentRouter({ analyze: kiroLike, develop: kiroLike, review: kiroLike });

    const role: AgentRole = "develop";
    expect((await routerA.forRole(role).run({ role, input: "x" })).output).toBe("c");
    expect((await routerB.forRole(role).run({ role, input: "x" })).output).toBe("k");
  });

  it("2. los adaptadores existentes siguen funcionando (contrato intacto)", async () => {
    // Construir los adaptadores reales no llama a sus CLIs; solo se verifica que
    // implementan el contrato y exponen su name (no se ejecuta run real).
    expect(new KiroCliAdapter().name).toBe("kiro-cli");
    expect(new ClaudeCliAdapter().name).toBe("claude-code");
    // Y el mock sigue respondiendo a todos los roles, incluido el nuevo.
    const mock = new MockAgentAdapter();
    const roles: AgentRole[] = ["analyze", "develop", "review", "huAnalyst", "technicalAnalyst", "functionalReviewer", "qualityReviewer", "assistant"];
    for (const role of roles) {
      const r = await mock.run({ role, input: "t" });
      expect(r.status).toBe("success");
      expect(r.role).toBe(role);
    }
  });

  it("3. OpenCode se registra como runtime OPCIONAL (y puede omitirse)", () => {
    const withOpt = createDefaultRuntimeRegistry({ includeOptional: true });
    expect(withOpt.has("opencode")).toBe(true);
    expect(withOpt.get("opencode").optional).toBe(true);

    const withoutOpt = createDefaultRuntimeRegistry({ includeOptional: false });
    expect(withoutOpt.has("opencode")).toBe(false);
    // Los no opcionales siguen presentes: nada depende de OpenCode.
    expect(withoutOpt.has("kiro")).toBe(true);
    expect(withoutOpt.has("claude")).toBe(true);
  });

  it("3b. el adaptador de OpenCode cumple el contrato sin CLI real (fallo explícito)", async () => {
    // Runner falso que simula que el binario no existe: debe devolver failure,
    // nunca lanzar. No se llama a OpenCode real.
    const adapter = new OpenCodeCliAdapter({
      runner: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: false, startError: "ENOENT", truncated: false }),
    });
    const r = await adapter.run({ role: "assistant", input: "investiga X" });
    expect(r.status).toBe("failure");
    expect(r.error).toContain("No se pudo iniciar");
  });

  it("selección por RUNTIME independiente del rol (RuntimeAwareRouter)", async () => {
    const kiro: AgentAdapter = { name: "kiro", async run(r) { return { status: "success", output: "kiro", role: r.role }; } };
    const opencode: AgentAdapter = { name: "opencode", async run(r) { return { status: "success", output: "opencode", role: r.role }; } };
    const router = new MapAgentRouter(
      { analyze: kiro, develop: kiro, review: kiro, assistant: kiro },
      { kiro, opencode },
    );
    expect(router.hasRuntime("opencode")).toBe(true);
    const out = await router.forRuntime("opencode").run({ role: "assistant", input: "x" });
    expect(out.output).toBe("opencode");
  });

  it("13. los permisos se validan ANTES de ejecutar (checkPermissions)", () => {
    const grant = PermissionGrant.readOnly(); // read_repo, read_kb, external_docs
    const okCheck = checkPermissions(["read_repo", "read_kb"], grant);
    expect(okCheck.ok).toBe(true);
    expect(okCheck.missing).toHaveLength(0);

    const badCheck = checkPermissions(["read_repo", "apply_changes"], grant);
    expect(badCheck.ok).toBe(false);
    expect(badCheck.missing).toContain("apply_changes");
  });

  it("capacidad apply_changes NO la declara ningún runtime de agente", () => {
    for (const d of defaultRuntimeDescriptors()) {
      expect(d.declaredCapabilities).not.toContain("apply_changes" as Capability);
    }
  });

  it("supports(): compatibilidad runtime vs capacidades requeridas", () => {
    const reg = new RuntimeRegistry();
    for (const d of defaultRuntimeDescriptors()) reg.register(d);
    const id: RuntimeId = "opencode";
    expect(reg.supports(id, ["read_repo", "external_docs"])).toBe(true);
    expect(reg.supports(id, ["propose_changes"])).toBe(false); // opencode no lo declara
  });
});
