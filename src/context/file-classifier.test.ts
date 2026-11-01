import { describe, it, expect } from "vitest";
import { classifyPath, exclusionOf, isSecretPath } from "./file-classifier.js";

/** (Project Context, T1) Clasificación por ruta, sin abrir archivos. */

const kindOf = (p: string) => classifyPath(p).kind;

describe("exclusiones", () => {
  it("directorios excluidos en cualquier nivel, no como nombre de archivo", () => {
    for (const p of ["node_modules/a/index.js", "packages/x/node_modules/y.js", ".git/HEAD", ".saiki/core.sqlite", "dist/main.js", "android/.gradle/x", "ios/Pods/a.h", ".dart_tool/p.json", "www/index.html", ".angular/cache/x"]) {
      expect(exclusionOf(p), p).toBe("excluded_dir");
    }
    expect(exclusionOf("src/build.ts")).toBeNull();
    expect(exclusionOf("scripts/dist")).toBeNull();
  });

  it("ruido: logs y .DS_Store", () => {
    expect(exclusionOf("npm-debug.log")).toBe("excluded_file");
    expect(exclusionOf("src/.DS_Store")).toBe("excluded_file");
  });
});

describe("secretos (solo por nombre)", () => {
  it("reconoce variables de entorno, claves, keystores y configuraciones con credenciales", () => {
    for (const p of [".env", ".env.local", "apps/api/.env.production", ".env.example", "certs/server.pem", "keys/app.key", "android/app/upload.jks", "android/key.keystore", "ios/dist.p12", "AuthKey_ABC.p8", "id_rsa", "id_ed25519.pub", ".npmrc", "android/app/google-services.json", "ios/Runner/GoogleService-Info.plist", "credentials.json", "config/secrets.yaml", "infra/prod.tfvars"]) {
      expect(isSecretPath(p), p).toBe(true);
      expect(kindOf(p), p).toBe("secret");
      expect(classifyPath(p).needsContentSniff, p).toBe(false);
    }
  });

  it("no confunde nombres parecidos de código", () => {
    for (const p of ["src/secretsManager.ts", "src/environment.ts", "src/env.ts", "lib/keyboard.dart", "src/credentialsForm.tsx"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});

describe("clasificación por stack", () => {
  it("Node / Angular / Ionic", () => {
    expect(kindOf("package.json")).toBe("manifest");
    expect(kindOf("package-lock.json")).toBe("manifest");
    expect(kindOf("angular.json")).toBe("config");
    expect(kindOf("ionic.config.json")).toBe("config");
    expect(kindOf("capacitor.config.ts")).toBe("config");
    expect(kindOf("tsconfig.app.json")).toBe("config");
    expect(kindOf("vite.config.ts")).toBe("config");
    expect(kindOf("karma.conf.js")).toBe("config");
    expect(classifyPath("src/app/auth/login.page.ts")).toEqual({ kind: "source", lang: "typescript", needsContentSniff: false });
    expect(kindOf("src/app/auth/login.page.spec.ts")).toBe("test");
    expect(kindOf("src/app/auth/login.page.scss")).toBe("source");
    expect(kindOf("e2e/app.po.ts")).toBe("test");
  });

  it("Flutter", () => {
    expect(kindOf("pubspec.yaml")).toBe("manifest");
    expect(kindOf("pubspec.lock")).toBe("manifest");
    expect(kindOf("analysis_options.yaml")).toBe("config");
    expect(classifyPath("lib/main.dart")).toEqual({ kind: "source", lang: "dart", needsContentSniff: false });
    expect(kindOf("test/widget_test.dart")).toBe("test");
    expect(kindOf("integration_test/app_test.dart")).toBe("test");
    expect(kindOf("android/app/build.gradle")).toBe("config");
    expect(kindOf("ios/Runner/Info.plist")).toBe("config");
    expect(classifyPath("lib/l10n/app_es.arb")).toEqual({ kind: "other", lang: "json", needsContentSniff: false });
  });

  it("genérico: otros ecosistemas, documentos, binarios y extensiones desconocidas", () => {
    expect(kindOf("go.mod")).toBe("manifest");
    expect(kindOf("Cargo.toml")).toBe("manifest");
    expect(classifyPath("cmd/server/main.go").lang).toBe("go");
    expect(kindOf("pkg/handler_test.go")).toBe("test");
    expect(kindOf("README.md")).toBe("doc");
    expect(kindOf("LICENSE")).toBe("doc");
    expect(kindOf("docs/arch/overview.md")).toBe("doc");
    expect(kindOf("assets/logo.png")).toBe("binary");
    expect(kindOf("Dockerfile")).toBe("config");
    expect(classifyPath("data/sample.csv")).toEqual({ kind: "other", lang: "csv", needsContentSniff: false });
    expect(classifyPath("tools/run")).toEqual({ kind: "other", lang: null, needsContentSniff: true });
  });

  it("es determinista", () => {
    expect(classifyPath("src/a.ts")).toEqual(classifyPath("src/a.ts"));
  });
});
