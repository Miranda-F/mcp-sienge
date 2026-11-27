import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsoDiario } from "../src/http/uso-diario.js";
import { carregarConfigHttp, criarServidorHttp } from "../src/servidor-http.js";
import { configTeste, paginar, REST, SiengeFake } from "./sienge-fake.js";

const TOKEN = "a".repeat(40);

describe("modo HTTP", () => {
  let fake: SiengeFake;
  let http: Server;
  let base: string;
  let pasta: string;

  beforeEach(async () => {
    fake = new SiengeFake();
    const sienge = await fake.iniciar();
    pasta = mkdtempSync(join(tmpdir(), "mcp-sienge-http-"));
    const cfgHttp = carregarConfigHttp({ MCP_AUTH_TOKENS: `equipe:${TOKEN}`, PORT: "3000" });
    http = criarServidorHttp(configTeste(sienge, { SIENGE_EXPORT_DIR: pasta }), cfgHttp, { uso: new UsoDiario(null) });
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    cfgHttp.urlPublica = base;
  });
  afterEach(async () => {
    await new Promise<void>((ok) => http.close(() => ok()));
    await fake.parar();
    rmSync(pasta, { recursive: true, force: true });
  });

  async function conectar(token?: string) {
    const cliente = new Client({ name: "teste-http", version: "1" });
    const transporte = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    });
    await cliente.connect(transporte);
    return cliente;
  }

  it("health responde sem token", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).modo).toBe("somente leitura");
  });

  it("recusa /mcp sem token ou com token errado", async () => {
    await expect(conectar()).rejects.toThrow();
    await expect(conectar("b".repeat(40))).rejects.toThrow();
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(401);
    expect(fake.requisicoes).toHaveLength(0);
  });

  it("aceita token por X-API-Key e recusa GET em /mcp", async () => {
    const r = await fetch(`${base}/mcp`, { headers: { "x-api-key": TOKEN } });
    expect(r.status).toBe(405);
  });

  it("lista e executa ferramentas com o token certo", async () => {
    fake.rota(`${REST}/companies`, paginar([{ id: 1, name: "Construtora A" }]));
    const cliente = await conectar(TOKEN);
    const { tools } = await cliente.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    const r = await cliente.callTool({ name: "sienge_empresas", arguments: {} });
    const json = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    expect(json.itens[0].name).toBe("Construtora A");
    await cliente.close();
  });

  it("exportação devolve link que baixa o CSV", async () => {
    fake.rota(`${REST}/companies`, paginar([{ id: 1, name: "Construtora A" }]));
    const cliente = await conectar(TOKEN);
    const r = await cliente.callTool({ name: "sienge_exportar_csv", arguments: { caminho: "/companies" } });
    const json = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    expect(json.link_csv).toMatch(new RegExp(`^${base}/exportacoes/companies_.+_[0-9a-f]{32}\\.csv$`));
    expect(json.arquivo_csv).toBeUndefined();
    const dl = await fetch(json.link_csv);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toContain("Construtora A");
    await cliente.close();
  });

  it("não serve arquivos fora do padrão de exportação", async () => {
    for (const p of ["/exportacoes/..%2Fpackage.json", "/exportacoes/x.csv", "/exportacoes/"]) {
      expect((await fetch(base + p)).status).toBe(404);
    }
  });

  it("exige token forte", () => {
    expect(() => carregarConfigHttp({})).toThrow(/MCP_AUTH_TOKENS/);
    expect(() => carregarConfigHttp({ MCP_AUTH_TOKENS: "curto" })).toThrow(/32 caracteres/);
    expect(carregarConfigHttp({ MCP_AUTH_TOKENS: `a:${TOKEN},b:${"c".repeat(32)}` }).tokens.size).toBe(2);
  });
});
