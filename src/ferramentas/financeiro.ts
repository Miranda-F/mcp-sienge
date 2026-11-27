import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agrupar, arredondar, hojeBrasil, mes, numero, somar } from "../agregacao.js";
import type { Query } from "../http/cliente.js";
import { periodoPadrao, prepararItens, registrar, respostaLista, zData, zId, type Contexto } from "./contexto.js";

type Registro = Record<string, unknown>;

const TIPO_DATA = { emissao: "I", vencimento: "D", pagamento: "P", competencia: "B" } as const;
const zTipoData = z
  .enum(["vencimento", "emissao", "pagamento", "competencia"])
  .default("vencimento")
  .describe("Qual data o período filtra: vencimento da parcela (padrão), emissão do título, pagamento ou competência");

/** Item expandido por rateio: uma parcela apropriada em várias obras vira várias linhas com fator. */
interface Fatia {
  item: Registro;
  chave: string;
  fator: number;
}

function porRateio(item: Registro, lista: string, nome: string, taxa: string): Fatia[] {
  const partes = Array.isArray(item[lista]) ? (item[lista] as Registro[]) : [];
  if (!partes.length) return [{ item, chave: "(sem apropriação)", fator: 1 }];
  return partes.map((p) => ({ item, chave: String(p[nome] ?? "(não informado)"), fator: numero(p[taxa]) / 100 || 0 }));
}

function pago(item: Registro, lista: string): number {
  const baixas = Array.isArray(item[lista]) ? (item[lista] as Registro[]) : [];
  return baixas.reduce((s, b) => s + numero(b.netAmount), 0);
}

type Dimensao = (item: Registro) => Fatia[];

function simples(campo: string): Dimensao {
  return (item) => [{ item, chave: String(item[campo] ?? "(não informado)"), fator: 1 }];
}

function agruparFatias(fatias: Fatia[], medidas: Record<string, (i: Registro) => number>, top: number) {
  return agrupar(
    fatias,
    (f) => f.chave,
    Object.fromEntries(Object.entries(medidas).map(([k, m]) => [k, (f: Fatia) => m(f.item) * f.fator])),
    top,
  );
}

export function registrarFinanceiro(servidor: McpServer, ctx: Contexto): void {
  const { consultor, cfg } = ctx;

  // ---------- Contas a pagar ----------

  const DIM_PAGAR: Record<string, Dimensao> = {
    credor: simples("creditorName"),
    empresa: simples("companyName"),
    mes_vencimento: (i) => [{ item: i, chave: mes(i.dueDate) ?? "(sem data)", fator: 1 }],
    documento: simples("documentIdentificationName"),
    obra: (i) => porRateio(i, "buildingsCosts", "buildingName", "rate"),
    plano_financeiro: (i) => porRateio(i, "paymentsCategories", "financialCategoryName", "financialCategoryRate"),
    centro_custo: (i) => porRateio(i, "paymentsCategories", "costCenterName", "financialCategoryRate"),
  };

  registrar(
    servidor,
    ctx,
    "sienge_resumo_contas_pagar",
    {
      titulo: "Resumo de contas a pagar",
      descricao:
        "Totais de contas a pagar num período: valor original, saldo em aberto, pago e vencido, agrupados por credor, empresa, mês, obra, plano financeiro, centro de custo ou documento. Usa Bulk Data (/outcome) numa única chamada, então serve para volumes grandes. Use para perguntas como 'quanto temos a pagar em dezembro', 'maiores credores', 'quanto está vencido na obra X'.",
      entrada: {
        data_inicio: zData.optional().describe("Padrão: primeiro dia do mês atual"),
        data_fim: zData.optional().describe("Padrão: último dia do mês atual"),
        tipo_data: zTipoData,
        empresa_id: zId.optional(),
        obra_id: zId.optional(),
        centros_custo: z.array(zId).optional(),
        credor: z.string().optional().describe("Filtra pelo nome do credor (contém, sem acento)"),
        somente_em_aberto: z.boolean().default(false).describe("Considerar só parcelas com saldo > 0"),
        agrupar_por: z.array(z.enum(Object.keys(DIM_PAGAR) as [string, ...string[]])).default(["mes_vencimento", "credor"]),
        top: z.number().int().min(1).max(100).default(15),
        exportar_csv: z.boolean().default(false),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const query: Query = {
        startDate: p.inicio,
        endDate: p.fim,
        selectionType: TIPO_DATA[a.tipo_data],
        correctionIndexerId: cfg.indexadorCorrecao,
        correctionDate: hojeBrasil(),
        companyId: a.empresa_id,
        buildingId: a.obra_id,
        costCentersId: a.centros_custo,
      };
      const r = await consultor.consultar("bulk", "/outcome", query, { maxRegistros: Number.MAX_SAFE_INTEGER });
      let itens = r.itens as Registro[];
      if (a.credor) {
        const alvo = a.credor.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        itens = itens.filter((i) => String(i.creditorName ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(alvo));
      }
      if (a.somente_em_aberto) itens = itens.filter((i) => numero(i.balanceAmount) > 0);
      const hoje = hojeBrasil();
      const vencidas = itens.filter((i) => numero(i.balanceAmount) > 0 && String(i.dueDate ?? "9999") < hoje);
      const medidas = {
        saldo: (i: Registro) => numero(i.balanceAmount),
        valor_original: (i: Registro) => numero(i.originalAmount),
        pago: (i: Registro) => pago(i, "payments"),
      };
      const grupos = Object.fromEntries(
        a.agrupar_por.map((d) => [d, agruparFatias(itens.flatMap(DIM_PAGAR[d]!), medidas, a.top)]),
      );
      return {
        periodo: { ...p, filtro_data: a.tipo_data, ...(p.padrao ? { observacao: "Período padrão (mês atual) porque não foi informado." } : {}) },
        parcelas: itens.length,
        titulos: new Set(itens.map((i) => i.billId)).size,
        totais: {
          valor_original: somar(itens, medidas.valor_original),
          saldo_em_aberto: somar(itens, medidas.saldo),
          saldo_corrigido: somar(itens, (i) => numero(i.correctedBalanceAmount)),
          pago: somar(itens, medidas.pago),
          vencido: { parcelas: vencidas.length, saldo: somar(vencidas, medidas.saldo) },
        },
        grupos,
        observacao_rateio: a.agrupar_por.some((d) => ["obra", "plano_financeiro", "centro_custo"].includes(d))
          ? "Agrupamentos por obra/plano/centro de custo usam o percentual de apropriação de cada parcela."
          : undefined,
        ...(a.exportar_csv ? ctx.exportar("contas-a-pagar", prepararItens(ctx, itens, "/outcome")) : {}),
        chamadas_api: r.chamadas,
      };
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_titulos_pagar",
    {
      titulo: "Listar títulos a pagar",
      descricao:
        "Lista títulos do contas a pagar (REST /bills) num período, com filtros por credor, empresa (devedora), centro de custo e documento. Para totais ou volumes grandes prefira sienge_resumo_contas_pagar.",
      entrada: {
        data_inicio: zData.optional(),
        data_fim: zData.optional(),
        credor_id: zId.optional(),
        empresa_id: zId.optional().describe("Empresa devedora (debtorId)"),
        centro_custo_id: zId.optional(),
        numero_documento: z.string().max(20).optional(),
        por_data_alteracao: z.boolean().default(false).describe("Filtra pela data de alteração em vez da data do título"),
        max_registros: z.number().int().positive().max(2000).default(200),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const caminho = a.por_data_alteracao ? "/bills/by-change-date" : "/bills";
      const r = await consultor.consultar(
        "v1",
        caminho,
        {
          startDate: p.inicio,
          endDate: p.fim,
          creditorId: a.credor_id,
          debtorId: a.empresa_id,
          costCenterId: a.centro_custo_id,
          documentNumber: a.numero_documento,
        },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      const itens = r.itens as Registro[];
      return respostaLista(ctx, r, caminho, ["id", "creditorId", "debtorId", "documentIdentificationId", "documentNumber", "issueDate", "installmentsNumber", "totalInvoiceAmount", "status", "originId", "purchaseOrderId", "contractNumber", "notes"], {
        periodo: p,
        valor_total_retornado: somar(itens, (i) => numero(i.totalInvoiceAmount)),
      });
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_titulo_pagar_detalhe",
    {
      titulo: "Detalhe de um título a pagar",
      descricao: "Mostra um título a pagar com parcelas, apropriações por obra e planos financeiros (4 chamadas REST).",
      entrada: { titulo_id: zId },
    },
    async ({ titulo_id }) => {
      const base = `/bills/${titulo_id}`;
      const [titulo, parcelas, obras, planos] = await Promise.all([
        consultor.consultar("v1", base, {}),
        consultor.consultar("v1", `${base}/installments`, {}),
        consultor.consultar("v1", `${base}/buildings-cost`, {}),
        consultor.consultar("v1", `${base}/budget-categories`, {}),
      ]);
      const dados = (r: typeof titulo) => (r.forma === "objeto" ? r.objeto : r.itens);
      return {
        titulo: prepararItens(ctx, [dados(titulo)], base)[0],
        parcelas: prepararItens(ctx, [dados(parcelas)].flat(), base),
        apropriacao_obras: prepararItens(ctx, [dados(obras)].flat(), base),
        planos_financeiros: prepararItens(ctx, [dados(planos)].flat(), base),
      };
    },
  );

  // ---------- Contas a receber ----------

  const DIM_RECEBER: Record<string, Dimensao> = {
    cliente: simples("clientName"),
    empresa: simples("companyName"),
    empreendimento: simples("projectName"),
    mes_vencimento: (i) => [{ item: i, chave: mes(i.dueDate) ?? "(sem data)", fator: 1 }],
    documento: simples("documentIdentificationName"),
    plano_financeiro: (i) => porRateio(i, "receiptsCategories", "financialCategoryName", "financialCategoryRate"),
    centro_custo: (i) => porRateio(i, "receiptsCategories", "costCenterName", "financialCategoryRate"),
  };

  registrar(
    servidor,
    ctx,
    "sienge_resumo_contas_receber",
    {
      titulo: "Resumo de contas a receber",
      descricao:
        "Totais de contas a receber num período: valor original, saldo em aberto, recebido e vencido, agrupados por cliente, empresa, empreendimento, mês, plano financeiro, centro de custo ou documento. Usa Bulk Data (/income) numa única chamada.",
      entrada: {
        data_inicio: zData.optional(),
        data_fim: zData.optional(),
        tipo_data: zTipoData,
        empresa_id: zId.optional(),
        centros_custo: z.array(zId).optional(),
        cliente: z.string().optional().describe("Filtra pelo nome do cliente (contém, sem acento)"),
        somente_em_aberto: z.boolean().default(false),
        agrupar_por: z.array(z.enum(Object.keys(DIM_RECEBER) as [string, ...string[]])).default(["mes_vencimento", "empreendimento"]),
        top: z.number().int().min(1).max(100).default(15),
        exportar_csv: z.boolean().default(false),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const r = await consultor.consultar(
        "bulk",
        "/income",
        {
          startDate: p.inicio,
          endDate: p.fim,
          selectionType: TIPO_DATA[a.tipo_data],
          companyId: a.empresa_id,
          costCentersId: a.centros_custo,
        },
        { maxRegistros: Number.MAX_SAFE_INTEGER },
      );
      let itens = r.itens as Registro[];
      if (a.cliente) {
        const alvo = a.cliente.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        itens = itens.filter((i) => String(i.clientName ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(alvo));
      }
      if (a.somente_em_aberto) itens = itens.filter((i) => numero(i.balanceAmount) > 0);
      const hoje = hojeBrasil();
      const vencidas = itens.filter((i) => numero(i.balanceAmount) > 0 && String(i.dueDate ?? "9999") < hoje);
      const medidas = {
        saldo: (i: Registro) => numero(i.balanceAmount),
        valor_original: (i: Registro) => numero(i.originalAmount),
        recebido: (i: Registro) => pago(i, "receipts"),
      };
      return {
        periodo: { ...p, filtro_data: a.tipo_data, ...(p.padrao ? { observacao: "Período padrão (mês atual) porque não foi informado." } : {}) },
        parcelas: itens.length,
        titulos: new Set(itens.map((i) => i.billId)).size,
        totais: {
          valor_original: somar(itens, medidas.valor_original),
          saldo_em_aberto: somar(itens, medidas.saldo),
          saldo_corrigido: somar(itens, (i) => numero(i.correctedBalanceAmount)),
          recebido: somar(itens, medidas.recebido),
          vencido: { parcelas: vencidas.length, saldo: somar(vencidas, medidas.saldo) },
        },
        grupos: Object.fromEntries(a.agrupar_por.map((d) => [d, agruparFatias(itens.flatMap(DIM_RECEBER[d]!), medidas, a.top)])),
        ...(a.exportar_csv ? ctx.exportar("contas-a-receber", prepararItens(ctx, itens, "/income")) : {}),
        chamadas_api: r.chamadas,
      };
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_titulos_receber_cliente",
    {
      titulo: "Títulos a receber de um cliente",
      descricao: "Lista os títulos do contas a receber de um cliente (REST) e, opcionalmente, as parcelas de cada título. Para totais gerais use sienge_resumo_contas_receber.",
      entrada: {
        cliente_id: zId,
        empresa_id: zId.optional(),
        centro_custo_id: zId.optional(),
        quitado: z.boolean().optional().describe("true = só quitados; false = só em aberto"),
        com_parcelas: z.boolean().default(false).describe("Busca também as parcelas (1 chamada por título, até 20 títulos)"),
      },
    },
    async (a) => {
      const caminho = "/accounts-receivable/receivable-bills";
      const r = await consultor.consultar("v1", caminho, {
        customerId: a.cliente_id,
        companyId: a.empresa_id,
        costCenterId: a.centro_custo_id,
        paidOff: a.quitado,
      });
      const resposta = respostaLista(ctx, r, caminho);
      if (a.com_parcelas && r.forma === "lista") {
        const titulos = (r.itens as Registro[]).slice(0, 20);
        const parcelas = await Promise.all(
          titulos.map(async (t) => {
            const id = t.receivableBillId ?? t.id ?? t.billId;
            const p = await consultor.consultar("v1", `${caminho}/${id}/installments`, {});
            return { titulo: id, parcelas: prepararItens(ctx, p.itens, caminho) };
          }),
        );
        resposta.parcelas_por_titulo = parcelas;
      }
      return resposta;
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_inadimplencia",
    {
      titulo: "Inadimplência (títulos em atraso)",
      descricao:
        "Resumo de inadimplência de uma empresa: total em atraso corrigido, por faixa de dias de atraso e maiores devedores. Usa Bulk Data (/defaulters-receivable-bills).",
      entrada: {
        empresa_id: zId,
        empreendimentos: z.array(zId).optional(),
        cliente_id: zId.optional(),
        data_posicao: zData.optional().describe("Data de referência (padrão: hoje)"),
        top: z.number().int().min(1).max(100).default(15),
        exportar_csv: z.boolean().default(false),
      },
    },
    async (a) => {
      const r = await consultor.consultar(
        "bulk",
        "/defaulters-receivable-bills",
        { companyId: a.empresa_id, enterpriseId: a.empreendimentos, customerId: a.cliente_id, positionDate: a.data_posicao },
        { maxRegistros: Number.MAX_SAFE_INTEGER },
      );
      const titulos = r.itens as Registro[];
      const parcelas: Registro[] = titulos.flatMap((t) =>
        (Array.isArray(t.defaulterInstallments) ? (t.defaulterInstallments as Registro[]) : []).map(
          (p): Registro => ({ ...p, clientName: t.clientName, receivableBillId: t.receivableBillId }),
        ),
      );
      const faixa = (d: number) => (d <= 30 ? "01-30 dias" : d <= 60 ? "31-60 dias" : d <= 90 ? "61-90 dias" : d <= 180 ? "91-180 dias" : "mais de 180 dias");
      const valor = (p: Registro) => numero(p.correctedValueWithAdditions);
      return {
        data_posicao: a.data_posicao ?? hojeBrasil(),
        titulos_inadimplentes: titulos.length,
        clientes: new Set(titulos.map((t) => t.clientId)).size,
        parcelas_em_atraso: parcelas.length,
        total_corrigido_com_encargos: somar(parcelas, valor),
        total_corrigido_sem_encargos: somar(parcelas, (p) => numero(p.correctedValueWithoutAdditions)),
        por_faixa_de_atraso: agrupar(parcelas, (p) => faixa(numero(p.daysOfDelay)), { valor }, 10).sort((x, y) => x.grupo.localeCompare(y.grupo)),
        maiores_devedores: agrupar(parcelas, (p) => p.clientName as string, { valor }, a.top),
        ...(a.exportar_csv ? ctx.exportar("inadimplencia", prepararItens(ctx, parcelas, "/defaulters-receivable-bills")) : {}),
        chamadas_api: r.chamadas,
      };
    },
  );

  // ---------- Caixa e bancos ----------

  registrar(
    servidor,
    ctx,
    "sienge_saldos_bancarios",
    {
      titulo: "Saldos das contas correntes",
      descricao: "Saldo de cada conta corrente/bancária numa data, com total por empresa.",
      entrada: {
        data: zData.optional().describe("Padrão: hoje"),
        empresa_id: zId.optional(),
        conta: z.string().optional(),
        incluir_inativas: z.boolean().default(false),
      },
    },
    async (a) => {
      const caminho = "/accounts-balances";
      const r = await consultor.consultar("v1", caminho, {
        balanceDate: a.data ?? hojeBrasil(),
        companyId: a.empresa_id,
        accountNumber: a.conta,
        accountStatus: a.incluir_inativas ? "ALL" : undefined,
        showLastBalanceIfNotExistBalance: "S",
      });
      const itens = r.itens as Registro[];
      return respostaLista(ctx, r, caminho, undefined, {
        data: a.data ?? hojeBrasil(),
        saldo_total: somar(itens, (i) => numero(i.amount)),
        por_empresa: agrupar(itens, (i) => i.companyId as number, { saldo: (i) => numero(i.amount) }, 50),
      });
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_extrato_bancario",
    {
      titulo: "Extrato de contas (movimentações)",
      descricao: "Movimentações financeiras das contas num período, com total de entradas e saídas. Para períodos longos use sienge_bulk com /bank-movement.",
      entrada: {
        data_inicio: zData.optional(),
        data_fim: zData.optional(),
        conta: z.string().optional(),
        empresa_id: zId.optional(),
        somente_nao_conciliados: z.boolean().default(false),
        max_registros: z.number().int().positive().max(5000).default(500),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const caminho = "/accounts-statements";
      const r = await consultor.consultar(
        "v1",
        caminho,
        { startDate: p.inicio, endDate: p.fim, accountNumber: a.conta, companyId: a.empresa_id, reconcile: a.somente_nao_conciliados || undefined },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      const itens = r.itens as Registro[];
      const entrada = (i: Registro) => /income|entrada|^e$/i.test(String(i.type ?? ""));
      const entradas = somar(itens.filter(entrada), (i) => Math.abs(numero(i.value)));
      const saidas = somar(itens.filter((i) => !entrada(i)), (i) => Math.abs(numero(i.value)));
      return respostaLista(
        ctx,
        r,
        caminho,
        ["date", "accountNumber", "companyId", "type", "value", "description", "documentNumber", "billId", "installmentNumber", "reconciliationDate", "statementOrigin"],
        { periodo: p, totais_retornados: { entradas, saidas, saldo: arredondar(entradas - saidas) } },
      );
    },
  );
}
