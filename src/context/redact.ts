/**
 * (Project Context, T4) Redacción de credenciales en texto que se guarda en el
 * snapshot (scripts de package.json, especificaciones de dependencias) y que
 * más adelante llegará a los agentes (T7).
 *
 * Determinista y conservadora: sustituye por `***` los formatos de token
 * conocidos, las credenciales dentro de URLs y los valores de opciones o
 * variables con nombre de secreto. No pretende detectar cualquier secreto: el
 * contenido de los archivos de secretos nunca se lee (T1).
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Tokens con formato conocido.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "***"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "***"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***"],
  // Credenciales en URLs: scheme://usuario:clave@host o scheme://token@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@"],
  // Opciones de línea de comandos con nombre de secreto: --token X, --password=X.
  [/(--?(?:[a-z-]*(?:token|secret|password|passwd|api-?key|auth)[a-z-]*)(?:=|\s+))(?!-)\S+/gi, "$1***"],
  // Variables de entorno en línea: FOO_TOKEN=valor.
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Z0-9_]*=)\S+/g, "$1***"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
