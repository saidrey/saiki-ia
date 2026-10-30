/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, createApiClient } from "./client";

/**
 * El cliente se prueba contra un servidor HTTP real local que responde con las
 * mismas formas que la API de Saiki-IA (docs/API.md). Sin mocks de fetch.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body: string, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.url === "/ok/health") return send(200, JSON.stringify({ ok: true }));
    if (req.url === "/notfound/health") return send(404, JSON.stringify({ error: "not_found", message: "Ruta no encontrada" }));
    if (req.url === "/proxy/health") return send(502, "Bad Gateway", "text/plain");
    if (req.url === "/html/health") return send(200, "<!doctype html>", "text/html");
    return send(500, JSON.stringify({ error: "internal_error", message: "fallo" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("se esperaba un ApiError");
}

describe("createApiClient", () => {
  it("devuelve el JSON de una respuesta 2xx", async () => {
    await expect(createApiClient(`${base}/ok`).health()).resolves.toEqual({ ok: true });
  });

  it("conserva el error y el mensaje de la API sin reinterpretarlos", async () => {
    const e = await caught(createApiClient(`${base}/notfound`).health());
    expect(e).toMatchObject({ status: 404, code: "not_found", message: "Ruta no encontrada" });
    expect(e.body).toEqual({ error: "not_found", message: "Ruta no encontrada" });
  });

  it("un 500 con cuerpo de error de la API se reporta tal cual", async () => {
    const e = await caught(createApiClient(`${base}/other`).health());
    expect(e).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("un 502 sin JSON (proxy sin backend) es 'unreachable'", async () => {
    const e = await caught(createApiClient(`${base}/proxy`).health());
    expect(e).toMatchObject({ status: 0, code: "unreachable" });
  });

  it("sin servidor escuchando es 'unreachable'", async () => {
    const e = await caught(createApiClient("http://127.0.0.1:9").health());
    expect(e).toMatchObject({ status: 0, code: "unreachable" });
  });

  it("un 2xx que no es JSON se rechaza (no se inventa una respuesta)", async () => {
    const e = await caught(createApiClient(`${base}/html`).health());
    expect(e.code).toBe("invalid_response");
  });
});
