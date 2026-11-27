import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Consultor } from "../src/consulta.js";
import { ClienteSienge } from "../src/http/cliente.js";
import { UsoDiario } from "../src/http/uso-diario.js";
import { CatalogoRotas } from "../src/rotas.js";
import { BULK, configTeste, paginar, REST, SiengeFake } from "./sienge-fake.js";

const catalogo = CatalogoRotas.carregar();
const empresas = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, name: `Empresa ${i + 1}` }));

describe("Consultor", () => {
  let fake: SiengeFake;
  let consultor: Consultor;

  beforeEach(async () => {
    fake = new SiengeFake();
    const base = await fake.iniciar();
    const cfg = configTeste(base);
    consultor = new Consultor(cfg, new ClienteSienge(cfg, { uso: new UsoDiario(null) }), catalogo);
  });
  afterEach(() => fake.parar());

  it("pagina de 200 em 200 até o total", async () => {
    fake.rota(`${REST}/companies`, paginar(empresas));
    const r = await consultor.consultar("v1", "/companies", {}, { maxRegistros: 1000 });
    expect(r.itens).toHaveLength(450);
    expect(r.total).toBe(450);
    expect(r.truncado).toBe(false);
    expect(r.chamadas).toBe(3);
    expect(fake.requisicoes.map((q) => q.query.get("offset"))).toEqual(["0", "200", "400"]);
  });

  it("para em max_registros e informa o próximo offset", async () => {
    fake.rota(`${REST}/companies`, paginar(empresas));
    const r = await consultor.consultar("v1", "/companies", {}, { maxRegistros: 250 });
    expect(r.itens).toHaveLength(250);
    expect(r.truncado).toBe(true);
    expect(r.proximoOffset).toBe(250);
    expect(fake.requisicoes.map((q) => q.query.get("limit"))).toEqual(["200", "50"]);
  });

  it("devolve resultado parcial se o limite estourar no meio", async () => {
    let n = 0;
    const pag = paginar(empresas);
    fake.rota(`${REST}/companies`, (req) => (++n === 1 ? pag(req) : { status: 429, headers: { "retry-after": "999" }, corpo: {} }));
    const r = await consultor.consultar("v1", "/companies", {}, { maxRegistros: 1000, prazo: Date.now() + 2000 });
    expect(r.itens).toHaveLength(200);
    expect(r.parcial).toBeTruthy();
    expect(r.truncado).toBe(true);
  });

  it("lê Bulk Data síncrono em uma chamada", async () => {
    fake.rota(`${BULK}/bank-movement`, () => ({ corpo: { data: [{ bankMovementId: 1 }, { bankMovementId: 2 }] } }));
    const r = await consultor.consultar("bulk", "/bank-movement", { startDate: "2025-01-01", endDate: "2025-01-31" }, { maxRegistros: Number.MAX_SAFE_INTEGER });
    expect(r.itens).toHaveLength(2);
    expect(r.chamadas).toBe(1);
  });

  it("acompanha Bulk assíncrono só com GET e sem webhook", async () => {
    fake.rota(`${BULK}/bank-movement`, () => ({ corpo: { identifier: "abc123" } }));
    fake.rota(`${BULK}/async/abc123`, () => ({ corpo: { status: "Finished", chunks: 2 } }));
    fake.rota(`${BULK}/async/abc123/result/1`, () => ({ corpo: { data: [{ a: 1 }] } }));
    fake.rota(`${BULK}/async/abc123/result/2`, () => ({ corpo: { data: [{ a: 2 }, { a: 3 }] } }));
    const r = await consultor.bulkAssincrono("/bank-movement", { startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(r.concluido).toBe(true);
    if (r.concluido) expect(r.itens).toHaveLength(3);
    expect(fake.requisicoes[0]!.query.get("_async")).toBe("true");
    expect(fake.requisicoes.some((q) => q.query.has("_asyncWebHookUrl"))).toBe(false);
    expect(new Set(fake.requisicoes.map((q) => q.metodo))).toEqual(new Set(["GET"]));
  });

  it("não chama o Sienge quando a rota é recusada", async () => {
    await expect(consultor.consultar("v1", "/hooks/1/../x", {})).rejects.toThrow();
    await expect(consultor.consultar("v1", "/creditor-report/pdf", {})).rejects.toThrow(/desabilitada/);
    expect(fake.requisicoes).toHaveLength(0);
  });
});
