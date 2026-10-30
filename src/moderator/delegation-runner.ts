import type { AgentRouter, RuntimeAwareRouter } from "../agents/router.js";
import { PermissionGrant, checkPermissions } from "../agents/capabilities.js";
import type { DelegatedTask } from "./delegation.js";

/**
 * Ejecutor de tareas delegadas (Fase 14).
 *
 * GARANTÍAS:
 *  1. Valida PERMISOS antes de ejecutar: si la tarea requiere capacidades que no
 *     tiene concedidas, se marca `blocked` y NO se ejecuta nada.
 *  2. Selecciona el adaptador por RUNTIME (independiente del rol) cuando el
 *     router lo soporta; si no, cae al adaptador por rol.
 *  3. El resultado del agente se guarda como DATO, nunca como decisión aprobada.
 *  4. Nunca escribe el repositorio: la capacidad `apply_changes` no se concede a
 *     tareas auxiliares; aunque se concediera, la escritura real es del Safe
 *     Applier, no de este runner.
 */

/** ¿El router sabe resolver por runtime? (type guard). */
function isRuntimeAware(router: AgentRouter): router is RuntimeAwareRouter {
  return (
    typeof (router as RuntimeAwareRouter).hasRuntime === "function" &&
    typeof (router as RuntimeAwareRouter).forRuntime === "function"
  );
}

export async function runDelegatedTask(
  task: DelegatedTask,
  router: AgentRouter,
): Promise<DelegatedTask> {
  const now = () => new Date().toISOString();

  // 1. VALIDACIÓN DE PERMISOS (antes de tocar nada).
  const grant = new PermissionGrant(task.grantedCapabilities);
  const check = checkPermissions(task.requiredCapabilities, grant);
  if (!check.ok) {
    return {
      ...task,
      status: "blocked",
      errors: [
        ...task.errors,
        `Permisos insuficientes: faltan [${check.missing.join(", ")}]. No se ejecutó.`,
      ],
      updatedAt: now(),
    };
  }

  // Defensa adicional: una tarea auxiliar NUNCA debe tener apply_changes.
  if (grant.allows("apply_changes")) {
    return {
      ...task,
      status: "blocked",
      errors: [
        ...task.errors,
        "Una tarea delegada no puede tener el permiso apply_changes (solo el Safe Applier escribe).",
      ],
      updatedAt: now(),
    };
  }

  // 2. Seleccionar adaptador: por RUNTIME si el router lo soporta, si no por rol.
  let adapter;
  try {
    adapter =
      isRuntimeAware(router) && router.hasRuntime(task.runtime)
        ? router.forRuntime(task.runtime)
        : router.forRole(task.agentRole);
  } catch (e) {
    return {
      ...task,
      status: "failed",
      errors: [...task.errors, e instanceof Error ? e.message : String(e)],
      updatedAt: now(),
    };
  }

  // 3. Ejecutar. El adaptador cumple el contrato: no lanza, devuelve AgentResult.
  const result = await adapter.run({
    role: task.agentRole,
    input: task.goal || task.request,
    context: task.context,
  });

  if (result.status === "failure") {
    return {
      ...task,
      status: "failed",
      errors: [...task.errors, result.error ?? "El agente devolvió un fallo sin detalle."],
      updatedAt: now(),
    };
  }

  // 4. Éxito: el resultado es un DATO para que el moderador lo presente. NO es
  //    una decisión aprobada ni conocimiento oficial.
  return {
    ...task,
    status: "succeeded",
    result: result.output,
    updatedAt: now(),
  };
}
