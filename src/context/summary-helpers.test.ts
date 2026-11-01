import { describe, it, expect } from "vitest";
import { parseYamlSubset } from "./minimal-yaml.js";
import { redactSecrets } from "./redact.js";

/** (Project Context, T4) Lector YAML mínimo (D7) y redacción de credenciales. */

describe("parseYamlSubset", () => {
  it("lee un pubspec típico: mapas anidados, comillas, comentarios; ignora listas y bloques", () => {
    const { data, skipped } = parseYamlSubset(
      [
        "name: notes_app # comentario",
        'description: "Notas: una app"',
        "version: 1.2.0+3",
        "publish_to: 'none'",
        "",
        "environment:",
        '  sdk: ">=3.0.0 <4.0.0"',
        "  flutter: 3.16.0",
        "",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "  provider: ^6.1.1",
        "  local_pkg:",
        "    path: ../local_pkg",
        "",
        "flutter:",
        "  uses-material-design: true",
        "  assets:",
        "    - assets/images/",
        "    - assets/icons/",
        "notes: |",
        "  línea 1",
        "  línea 2",
        "after: ok",
      ].join("\n"),
    );
    expect(data).toEqual({
      name: "notes_app",
      description: "Notas: una app",
      version: "1.2.0+3",
      publish_to: "none",
      environment: { sdk: ">=3.0.0 <4.0.0", flutter: "3.16.0" },
      dependencies: { flutter: { sdk: "flutter" }, provider: "^6.1.1", local_pkg: { path: "../local_pkg" } },
      flutter: { "uses-material-design": "true", assets: {} },
      notes: "",
      after: "ok",
    });
    expect(skipped).toBe(3); // dos elementos de lista y el bloque
  });

  it("no lanza con entrada basura, tabuladores o vacía", () => {
    expect(parseYamlSubset("").data).toEqual({});
    const r = parseYamlSubset("{{{\n\tkey: x\n:::\nok: 1");
    expect(r.data).toEqual({ ok: "1" });
    expect(r.skipped).toBe(3);
  });
});

describe("redactSecrets", () => {
  it("oculta tokens conocidos, credenciales en URLs y opciones/variables de secreto", () => {
    const cases: Array<[string, string]> = [
      ["firebase deploy --token 1//0gABCdef", "firebase deploy --token ***"],
      ["deploy --password=hunter2 --force", "deploy --password=*** --force"],
      ["NPM_TOKEN=abc123 npm publish", "NPM_TOKEN=*** npm publish"],
      ["git+https://user:pass@github.com/x/y.git", "git+https://***@github.com/x/y.git"],
      ["https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x", "https://***@github.com/x"],
      [`curl -H "x: ghp_${"a".repeat(36)}"`, 'curl -H "x: ***"'],
      [`echo sk-ant-${"b".repeat(30)}`, "echo ***"],
      ["AKIAABCDEFGHIJKLMNOP", "***"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input), input).toBe(expected);
  });

  it("no altera comandos normales ni rangos de versión", () => {
    for (const s of ["ng build --configuration production", "tsx src/api/serve.ts", "^7.8.0", "vitest run --reporter=dot", "https://registry.npmjs.org/"]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
});
