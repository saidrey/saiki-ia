/**
 * Extracción de la respuesta estructurada (un objeto JSON) de la salida de un
 * agente. Los agentes suelen escribir texto antes o después del JSON, a veces
 * con llaves (`{ a, b }`) o bloques Markdown; tomar "de la primera `{` a la
 * última `}`" falla en esos casos.
 *
 * Estrategia:
 *  1. Se buscan los objetos JSON completos del texto (ver `scan`): un objeto
 *     válido se toma entero (sus objetos internos no son candidatos aparte); si
 *     una pareja de llaves no es JSON, se prueban las que contiene.
 *  2. De los candidatos, se queda el que cumple el esquema del consumidor
 *     (`isValid`). Si varios distintos lo cumplen, es ambiguo y se rechaza.
 *  3. Si ninguno lo cumple: con un objeto sin cerrar, la respuesta está
 *     incompleta (error); si no, se devuelve el último candidato para que el
 *     consumidor lo rechace con sus errores de validación (nunca se acepta en
 *     silencio un objeto incorrecto).
 */

export type AgentJsonResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Objetos JSON completos del texto, en orden. */
export function jsonObjectCandidates(text: string): unknown[] {
  return scan(text).candidates;
}

/**
 * Una pasada lineal: empareja cada `{` con su `}` (pila), ignorando las llaves
 * dentro de cadenas. Una cadena JSON no puede contener un salto de línea
 * literal, así que una comilla suelta en la prosa deja de contar al terminar la
 * línea. Después se prueba `JSON.parse` en cada pareja, de fuera hacia dentro:
 * un objeto aceptado se toma entero y sus parejas internas se saltan.
 */
function scan(text: string): { candidates: unknown[]; unclosed: boolean } {
  const pairs: Array<[number, number]> = [];
  const open: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"' || ch === "\n") inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") open.push(i);
    else if (ch === "}" && open.length > 0) pairs.push([open.pop()!, i]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  const candidates: unknown[] = [];
  let acceptedEnd = -1;
  for (const [from, to] of pairs) {
    if (from < acceptedEnd) continue; // dentro de un objeto ya aceptado
    try {
      const value: unknown = JSON.parse(text.slice(from, to + 1));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        candidates.push(value);
        acceptedEnd = to;
      }
    } catch {
      // No es JSON (p. ej. llaves en prosa): se prueban las parejas internas.
    }
  }
  return { candidates, unclosed: open.length > 0 };
}

/**
 * El objeto JSON de la respuesta que cumple el esquema del consumidor. Ver la
 * estrategia arriba. `ok: false` = no hay ningún objeto completo o es ambiguo.
 */
export function extractAgentJson(text: string, isValid: (candidate: unknown) => boolean): AgentJsonResult {
  const { candidates, unclosed } = scan(text);
  if (candidates.length === 0) {
    return { ok: false, error: "la respuesta no contiene un objeto JSON completo" };
  }
  const valid = candidates.filter(isValid);
  const distinct = [...new Map(valid.map((v) => [JSON.stringify(v), v])).values()];
  if (distinct.length > 1) {
    return { ok: false, error: `la respuesta contiene ${distinct.length} objetos JSON válidos distintos; no se elige uno` };
  }
  if (distinct.length === 1) return { ok: true, value: distinct[0] };
  // Sin ninguno válido: si hay un objeto sin cerrar, lo encontrado son fragmentos internos de una respuesta incompleta.
  if (unclosed) return { ok: false, error: "la respuesta contiene un objeto JSON incompleto o mal cerrado" };
  return { ok: true, value: candidates[candidates.length - 1] };
}
