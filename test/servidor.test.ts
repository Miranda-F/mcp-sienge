import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsoDiario } from "../src/http/uso-diario.js";
import { criarContexto, criarServidor } from "../src/servidor.js";
import { BULK, configTeste, paginar, REST, SiengeFake } from "./sienge-fake.js";

type Texto = { type: "text"; text: string };

const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

const parcelasPagar = [
  {
    billId: 1,
    installmentId: 1,
    creditorName: "Cimento Forte Ltda",
    companyName: "Construtora A",
    dueDate: "2000-01-10",
    originalAmount: 1000,
    balanceAmount: 1000,
    correctedBalanceAmount: 1000,
    buildingsCosts: [
      { buildingName: "Residencial Sol", rate: 60 },
      { buildingName: "Torre Lua", rate: 40 },
    ],
    payments: [],
  },
  {
    billId: 2,
    installmentId: 1,
    creditorName: "Aço Brasil SA",
    companyName: "Construtora A",
    dueDate: "2999-01-20",
    originalAmount: 500,
    balanceAmount: 200,
    correctedBalanceAmount: 200,
    buildingsCosts: [{ buildingName: "Torre Lua", rate: 100 }],
    payments: [{ netAmount: 300 }],
  },
];

describe("servidor MCP", () => {
  let fake: SiengeFake;
  let cliente: Client;
  let pastaExport: string;

  beforeEach(async () => {
    fake = new SiengeFake();
    const base = await fake.iniciar();
    pastaExport = mkdtempSync(join(tmpdir(), "mcp-sienge-"));
    const servidor = criarServidor(criarContexto(configTeste(base, { SIENGE_EXPORT_DIR: pastaExport }), { uso: new UsoDiario(null) }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    cliente = new Client({ name: "teste", version: "1" });
    await Promise.all([servidor.connect(a), cliente.connect(b)]);
  });
  afterEach(async () => {
    await cliente.close();
    await fake.parar();
    rmSync(pastaExport, { recursive: true, force: true });
  });

  async function chamar(nome: string, args: Record<string, unknown> = {}) {
    const r = await cliente.callTool({ name: nome, arguments: args });
    const texto = (r.content as Texto[])[0]!.text;
    return { erro: Boolean(r.isError), texto, json: r.isError ? undefined : JSON.parse(texto) };
  }

  it("todas as ferramentas são marcadas como somente leitura", async () => {
    const { tools } = await cliente.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    for (const t of tools) {
      expect(t.name).toMatch(/^sienge_/);
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("resume contas a pagar com rateio por obra e vencidos", async () => {
    fake.rota(`${BULK}/outcome`, () => ({ corpo: { data: parcelasPagar } }));
    const { json } = await chamar("sienge_resumo_contas_pagar", {
      data_inicio: "2000-01-01",
      data_fim: "2999-12-31",
      agrupar_por: ["obra", "credor"],
    });
    expect(json.parcelas).toBe(2);
    expect(json.totais.saldo_em_aberto).toBe(1200);
    expect(json.totais.pago).toBe(300);
    expect(json.totais.vencido).toEqual({ parcelas: 1, saldo: 1000 });
    const obras = Object.fromEntries(json.grupos.obra.map((g: { grupo: string; saldo: number }) => [g.grupo, g.saldo]));
    expect(obras).toEqual({ "Torre Lua": 600, "Residencial Sol": 600 });
    const q = fake.requisicoes[0]!.query;
    expect(q.get("selectionType")).toBe("D");
    expect(q.get("correctionDate")).toBe(hoje);
  });

  it("consulta genérica pagina e informa continuação", async () => {
    fake.rota(`${REST}/companies`, paginar(Array.from({ length: 30 }, (_, i) => ({ id: i, name: `E${i}`, links: [{ x: 1 }] }))));
    const { json } = await chamar("sienge_consultar", { caminho: "/companies", max_registros: 10 });
    expect(json.retornados).toBe(10);
    expect(json.total_no_sienge).toBe(30);
    expect(json.proximo_offset).toBe(10);
    expect(json.itens[0].links).toBeUndefined();
  });

  it("recusa consulta genérica fora da lista sem chamar o Sienge", async () => {
    const r = await chamar("sienge_consultar", { caminho: "/products" });
    expect(r.erro).toBe(true);
    expect(r.texto).toContain("não está na lista");
    expect(fake.requisicoes).toHaveLength(0);
  });

  it("mascara CPF nas respostas", async () => {
    fake.rota(`${REST}/creditors`, paginar([{ id: 7, name: "João", cpf: "123.456.789-01" }]));
    const { json } = await chamar("sienge_credores", { nome: "João" });
    expect(json.itens[0].cpf).toBe("***01");
    expect(fake.requisicoes[0]!.query.get("creditor")).toBe("João");
  });

  it("exporta CSV no padrão brasileiro", async () => {
    fake.rota(`${REST}/companies`, paginar([{ id: 1, name: "Construtora; A", valor: 10.5 }]));
    const { json } = await chamar("sienge_exportar_csv", { caminho: "/companies" });
    const csv = readFileSync(json.arquivo_csv, "utf8");
    expect(json.arquivo_csv.startsWith(pastaExport)).toBe(true);
    expect(csv).toContain("id;name;valor");
    expect(csv).toContain('1;"Construtora; A";10,5');
  });

  it("inadimplência agrupa por faixa de atraso", async () => {
    fake.rota(`${BULK}/defaulters-receivable-bills`, () => ({
      corpo: {
        data: [
          { clientId: 1, clientName: "Ana", receivableBillId: 9, defaulterInstallments: [{ daysOfDelay: 10, correctedValueWithAdditions: 100 }, { daysOfDelay: 200, correctedValueWithAdditions: 50 }] },
        ],
      },
    }));
    const { json } = await chamar("sienge_inadimplencia", { empresa_id: 1 });
    expect(json.total_corrigido_com_encargos).toBe(150);
    expect(json.por_faixa_de_atraso.map((g: { grupo: string }) => g.grupo)).toEqual(["01-30 dias", "mais de 180 dias"]);
  });

  it("nunca envia métodos diferentes de GET", async () => {
    fake.rota(`${REST}/companies`, paginar([{ id: 1 }]));
    fake.rota(`${BULK}/outcome`, () => ({ corpo: { data: parcelasPagar } }));
    await chamar("sienge_status");
    await chamar("sienge_empresas");
    await chamar("sienge_resumo_contas_pagar", {});
    expect(fake.requisicoes.length).toBeGreaterThan(0);
    expect(new Set(fake.requisicoes.map((r) => r.metodo))).toEqual(new Set(["GET"]));
  });
});
