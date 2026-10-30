/**
 * Lectura de `finalResult.outcome` (fase terminal). Textos según docs/APPLY.md y
 * `src/core/execution-view.ts`; una fase desconocida se muestra tal cual.
 */
export type OutcomeTone = "success" | "warning" | "failure" | "stopped";

const OUTCOMES: Record<string, { tone: OutcomeTone; text: string }> = {
  applied: { tone: "success", text: "Cambios aplicados y verificados: el contenido en disco coincide con lo aprobado." },
  applied_with_test_failures: {
    tone: "warning",
    text: "Cambios aplicados y verificados, pero los tests o el typecheck del proyecto fallaron.",
  },
  rolled_back: { tone: "failure", text: "Falló al aplicar y se revirtieron los cambios parciales: el repositorio quedó intacto." },
  unrecoverable: { tone: "failure", text: "Falló al aplicar y la reversión no se completó: requiere revisión manual del repositorio." },
  apply_blocked: { tone: "failure", text: "Bloqueado antes de escribir: no se aplicó nada. El motivo está en el detalle." },
  rejected: { tone: "stopped", text: "La HU se rechazó: no se desarrolló nada." },
  revision_limit: { tone: "stopped", text: "Se agotaron las revisiones de la HU: no se desarrolló nada." },
  blocked: { tone: "stopped", text: "Se detuvo antes de desarrollar por la viabilidad: no se desarrolló nada." },
  final_approval_rejected: { tone: "stopped", text: "La propuesta final se rechazó: no se aplicó nada." },
  reviews_exhausted: { tone: "stopped", text: "Se agotaron los ciclos de revisión sin aprobación: no se aplicó nada." },
  failed: { tone: "failure", text: "Falló el análisis de la HU." },
  tech_failed: { tone: "failure", text: "Falló el análisis técnico." },
  dev_failed: { tone: "failure", text: "Falló el desarrollo de la propuesta." },
  review_failed: { tone: "failure", text: "Falló una revisión." },
};

export function describeOutcome(outcome: string | undefined): { tone: OutcomeTone; text: string } {
  if (outcome === undefined) return { tone: "stopped", text: "El backend no indicó el desenlace." };
  return OUTCOMES[outcome] ?? { tone: "stopped", text: `Terminada con la fase «${outcome}».` };
}
