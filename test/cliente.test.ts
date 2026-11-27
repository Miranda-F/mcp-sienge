import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClienteSienge, ErroSienge } from "../src/http/cliente.js";
import { UsoDiario } from "../src/http/uso-diario.js";
import { configTeste, REST, SiengeFake } from "./sienge-fake.js";

describe("ClienteSienge", () => {
  let fake: SiengeFake;
  let base: string;

  beforeEach(async () => {
    fake = new SiengeFake();
    base = await fake.iniciar();
  });
  afterEach(() => fake.parar());

  it("só tem método GET e envia Basic Auth", async () => {
    fake.rota(`${REST}/companies`, () => ({ corpo: { ok: 1 } }));
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null) });
    expect(Object.getOwnPropertyNames(ClienteSienge.prototype).filter((n) => /^(post|put|patch|delete)$/i.test(n))).toEqual([]);
    await c.get("rest", "/companies", { limit: 1 });
    expect(fake.requisicoes[0]!.metodo).toBe("GET");
    expect(fake.requisicoes[0]!.autorizacao).toBe("Basic " + Buffer.from("usuario-api:senha").toString("base64"));
    expect(fake.requisicoes[0]!.query.get("limit")).toBe("1");
  });

  it("monta URLs REST e Bulk e repete chaves de array", () => {
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null) });
    expect(c.montarUrl("rest", "/bills", { startDate: "2025-01-01", vazio: undefined })).toBe(`${base}/teste/public/api/v1/bills?startDate=2025-01-01`);
    expect(c.montarUrl("bulk", "/outcome", { costCentersId: [1, 2] })).toBe(`${base}/teste/public/api/bulk-data/v1/outcome?costCentersId=1&costCentersId=2`);
  });

  it("recusa caminhos inseguros", () => {
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null) });
    for (const p of ["/../admin", "//evil.com/x", "/bills?x=1", "bills", "/a b"]) {
      expect(() => c.montarUrl("rest", p)).toThrow(ErroSienge);
    }
  });

  it("repete após 429 respeitando Retry-After", async () => {
    let n = 0;
    fake.rota(`${REST}/companies`, () => (++n === 1 ? { status: 429, headers: { "retry-after": "2" }, corpo: {} } : { corpo: { ok: true } }));
    const esperas: number[] = [];
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null), dormir: async (ms) => void esperas.push(ms) });
    await expect(c.get("rest", "/companies")).resolves.toEqual({ ok: true });
    expect(esperas).toEqual([2000]);
  });

  it("traduz erro do Sienge com clientMessage", async () => {
    fake.rota(`${REST}/bills`, () => ({ status: 400, corpo: { status: 400, clientMessage: "Parâmetro obrigatório startDate ausente", errors: [{ field: "startDate", message: "não pode ser nulo" }] } }));
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null) });
    const erro = (await c.get("rest", "/bills").catch((e) => e)) as ErroSienge;
    expect(erro.status).toBe(400);
    expect(erro.message).toContain("startDate ausente");
    expect(erro.campos?.[0]?.field).toBe("startDate");
  });

  it("bloqueia quando a cota diária configurada acaba", async () => {
    fake.rota(`${REST}/companies`, () => ({ corpo: [] }));
    const c = new ClienteSienge(configTeste(base, { SIENGE_DAILY_QUOTA_REST: "2" }), { uso: new UsoDiario(null) });
    await c.get("rest", "/companies");
    await c.get("rest", "/companies", { x: 2 });
    await expect(c.get("rest", "/companies", { x: 3 })).rejects.toMatchObject({ tipo: "cota" });
    expect(fake.requisicoes).toHaveLength(2);
  });

  it("usa cache quando pedido", async () => {
    fake.rota(`${REST}/companies`, () => ({ corpo: [{ id: 1 }] }));
    const c = new ClienteSienge(configTeste(base), { uso: new UsoDiario(null) });
    await c.get("rest", "/companies", {}, { cacheMs: 60_000 });
    await c.get("rest", "/companies", {}, { cacheMs: 60_000 });
    expect(fake.requisicoes).toHaveLength(1);
  });
});

describe("configuração", () => {
  it("só aceita a API oficial ou localhost", () => {
    expect(() => configTeste("https://evil.example.com")).toThrow(/SIENGE_BASE_URL/);
    expect(() => configTeste("http://api.sienge.com.br")).toThrow(/SIENGE_BASE_URL/);
    expect(configTeste("https://api.sienge.com.br").baseUrl).toBe("https://api.sienge.com.br");
  });
});
