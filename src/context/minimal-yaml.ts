/**
 * (Project Context, T4, D7) Lector MÍNIMO de YAML para `pubspec.yaml` y
 * `pubspec.lock`. Sin dependencias nuevas.
 *
 * Soporta solo lo que usan esos archivos: mapas anidados por indentación con
 * espacios y escalares (con o sin comillas). Lo demás se ignora y se cuenta en
 * `skipped`: elementos de lista (`- x`), bloques `|`/`>`, líneas con tabulador
 * o sin forma `clave: valor`. Los mapas en línea (`{a: 1}`) quedan como texto.
 * Nunca lanza.
 */

export type YamlValue = string | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export interface YamlParse {
  data: YamlMap;
  /** Líneas que no se interpretaron. */
  skipped: number;
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:'"#][^:#]*?)\s*:(?:\s+(.*))?$/;

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

/** Valor escalar sin comentario final (` # ...`), respetando comillas. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    return end === -1 ? v : v.slice(1, end);
  }
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

export function parseYamlSubset(text: string): YamlParse {
  const data: YamlMap = {};
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: data }];
  let skipped = 0;
  let blockIndent: number | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue; // contenido de un bloque | o >
      blockIndent = null;
    }
    if (/^\s*\t/.test(rawLine)) {
      skipped++;
      continue;
    }
    const line = rawLine.trim();
    if (line === "-" || line.startsWith("- ")) {
      skipped++; // listas: no se necesitan
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m) {
      skipped++;
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].map;
    const key = unquote(m[1].trim());
    const value = m[2] === undefined ? "" : scalar(m[2]);

    if (value === "" && (m[2] === undefined || m[2].trim().startsWith("#"))) {
      const child: YamlMap = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else if (/^[|>][+-]?\d*$/.test(value)) {
      parent[key] = "";
      blockIndent = indent;
      skipped++;
    } else {
      parent[key] = value;
    }
  }
  return { data, skipped };
}

/** Acceso seguro a un mapa hijo. */
export function yamlMap(v: YamlValue | undefined): YamlMap | null {
  return v !== undefined && typeof v === "object" ? v : null;
}

/** Acceso seguro a un escalar. */
export function yamlString(v: YamlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}
