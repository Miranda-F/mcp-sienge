import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agrupar, numero } from "../agregacao.js";
import type { Query } from "../http/cliente.js";
import { prepararItens, registrar, respostaLista, type Contexto } from "./contexto.js";

const zBase = z.enum(["v1", "bulk"]).default("v1").describe('"v1" para a API REST, "bulk" para Bulk Data');
const zParametros = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
  .default({})
  .describe("Parâmetros de query exatamente como documentados na rota (ex.: {\"startDate\":\"2025-01-01\"})");
const zCampos = z.array(z.string()).optional().describe("Campos a manter em cada item (ex.: [\"id\",\"name\"]). Aceita ponto para campos internos.");

export function registrarGenericas(servidor: McpServer, ctx: Contexto): void {
  const { consultor, cfg } = ctx;

  registrar(
    servidor,
    ctx,
    "sienge_status",
    {
      titulo: "Status da conexão com o Sienge",
      descricao:
        "Testa a conexão com o Sienge e mostra a configuração (subdomínio, limites) e quantas chamadas este servidor já fez hoje. Use primeiro se houver erro de autenticação.",
      entrada: {},
    },
    async () => {
      const inicio = Date.now();
      let conexao: Record<string, unknown>;
      try {
        await consultor.cliente.get("rest", "/companies", { limit: 1 }, {});
        conexao = { ok: true, latencia_ms: Date.now() - inicio };
      } catch (e) {
        conexao = { ok: false, erro: (e as Error).message };
      }
      const uso = consultor.cliente.uso.resumo();
      return {
        servidor: "mcp-sienge (somente leitura)",
        subdominio: cfg.subdominio,
        conexao,
        uso_hoje: {
          dia: uso.dia,
          rest: uso.rest,
          bulk: uso.bulk,
          cota_rest: cfg.cotaDiariaRest ?? "não configurada",
          cota_bulk: cfg.cotaDiariaBulk ?? "não configurada",
        },
        limites_por_minuto: { rest: cfg.limitePorMinutoRest, bulk: cfg.limitePorMinutoBulk },
        max_registros_por_consulta: cfg.maxRegistros,
        rotas_liberadas: consultor.catalogo.todas().filter((r) => !r.bloqueado).length,
      };
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_rotas",
    {
      titulo: "Pesquisar consultas disponíveis no Sienge",
      descricao:
        "Lista as consultas GET disponíveis na API do Sienge (catálogo oficial). Pesquise por palavra (ex.: 'pedido', 'contas a pagar', 'saldo') ou área (Engenharia, Suprimentos, Financeiro, Comercial, Contabilidade, Apoio, Bulk Data). Informe 'id' para ver os parâmetros e campos de uma rota antes de usar sienge_consultar.",
      entrada: {
        busca: z.string().optional().describe("Palavras para pesquisar no caminho, módulo ou descrição"),
        area: z.string().optional(),
        base: z.enum(["v1", "bulk"]).optional(),
        id: z.string().optional().describe('Id da rota para detalhar, ex.: "v1:/bills" ou "bulk:/outcome"'),
      },
    },
    async ({ busca, area, base, id }) => {
      if (id) {
        const r = consultor.catalogo.porId(id);
        if (!r) return { erro: `Rota ${id} não encontrada. Pesquise sem 'id' para ver as disponíveis.` };
        return {
          id: r.id,
          caminho: r.caminho,
          base: r.base,
          modulo: r.modulo,
          area: r.area,
          resumo: r.resumo,
          descricao: r.descricao,
          paginado: r.paginado,
          ...(r.bloqueado ? { bloqueado: r.bloqueado } : {}),
          parametros: r.parametros.filter((p) => !["limit", "offset"].includes(p.nome)),
          campos_resposta: r.campos,
        };
      }
      const achadas = consultor.catalogo.pesquisar({ texto: busca, area, base });
      return {
        encontradas: achadas.length,
        rotas: achadas.slice(0, 80).map((r) => ({
          id: r.id,
          resumo: r.resumo,
          modulo: r.modulo,
          obrigatorios: r.parametros.filter((p) => p.obrigatorio).map((p) => p.nome),
        })),
        ...(achadas.length > 80 ? { aviso: "Mais de 80 rotas; refine a busca." } : {}),
      };
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_consultar",
    {
      titulo: "Consulta genérica (GET) no Sienge",
      descricao:
        "Executa qualquer consulta GET do catálogo (veja sienge_rotas). Informe o caminho concreto, com os ids no lugar dos {parâmetros}, ex.: '/purchase-orders/123/items'. Rotas paginadas são percorridas automaticamente até max_registros. Prefira as ferramentas específicas quando existirem.",
      entrada: {
        caminho: z.string().describe("Caminho da rota, ex.: /bills ou /enterprises/5"),
        base: zBase,
        parametros: zParametros,
        campos: zCampos,
        max_registros: z.number().int().positive().max(5000).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ caminho, base, parametros, campos, max_registros, offset }) => {
      const r = await consultor.consultar(base, caminho, parametros as Query, { maxRegistros: max_registros, offset });
      return respostaLista(ctx, r, caminho, campos);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_bulk",
    {
      titulo: "Extração em massa (Bulk Data) com resumo",
      descricao:
        "Consulta uma rota Bulk Data (base bulk, ex.: /outcome, /income, /bank-movement, /defaulters-receivable-bills) e devolve o total de registros, um resumo agrupado e uma amostra. Bulk tem limite de 20 chamadas/min e cota diária baixa: use filtros completos. modo 'assincrono' serve para volumes muito grandes.",
      entrada: {
        caminho: z.string(),
        parametros: zParametros,
        agrupar_por: z.string().optional().describe("Campo para agrupar (ex.: creditorName, companyName)"),
        somar: z.array(z.string()).optional().describe("Campos numéricos a somar por grupo (ex.: [\"balanceAmount\"])"),
        amostra: z.number().int().min(0).max(200).default(20).describe("Quantos itens devolver como amostra"),
        campos: zCampos,
        modo: z.enum(["sincrono", "assincrono"]).default("sincrono"),
        exportar_csv: z.boolean().default(false).describe("Grava todos os registros em CSV no computador local"),
      },
    },
    async ({ caminho, parametros, agrupar_por, somar, amostra, campos, modo, exportar_csv }) => {
      let itens: unknown[];
      let chamadas: number;
      if (modo === "assincrono") {
        const r = await consultor.bulkAssincrono(caminho, parametros as Query);
        if (!r.concluido) {
          return {
            concluido: false,
            identificador: r.identificador,
            status: r.status,
            proximo_passo: "A extração continua no Sienge. Chame sienge_bulk_resultado com este identificador em alguns segundos.",
          };
        }
        itens = r.itens;
        chamadas = r.chamadas;
      } else {
        const r = await consultor.consultar("bulk", caminho, parametros as Query, { maxRegistros: Number.MAX_SAFE_INTEGER });
        itens = r.forma === "lista" ? r.itens : [r.objeto];
        chamadas = r.chamadas;
      }
      return resumirBulk(ctx, caminho, itens, chamadas, { agrupar_por, somar, amostra, campos, exportar_csv });
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_bulk_resultado",
    {
      titulo: "Resultado de extração Bulk assíncrona",
      descricao: "Acompanha uma extração Bulk Data assíncrona iniciada por sienge_bulk (modo assincrono) e devolve o resumo quando terminar. Os resultados ficam no Sienge por 24 h.",
      entrada: {
        identificador: z.string(),
        agrupar_por: z.string().optional(),
        somar: z.array(z.string()).optional(),
        amostra: z.number().int().min(0).max(200).default(20),
        campos: zCampos,
        exportar_csv: z.boolean().default(false),
      },
    },
    async ({ identificador, ...opcoes }) => {
      const r = await consultor.acompanharBulk(identificador);
      if (!r.concluido) return { concluido: false, identificador, status: r.status, proximo_passo: "Ainda processando; tente de novo em alguns segundos." };
      return resumirBulk(ctx, `/async/${identificador}`, r.itens, r.chamadas, opcoes);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_exportar_csv",
    {
      titulo: "Exportar consulta para CSV",
      descricao:
        "Executa uma consulta GET do catálogo (REST ou Bulk) buscando todos os registros até max_registros e grava um arquivo CSV (separador ';', abre no Excel) no computador local. Devolve o caminho do arquivo e o total. Use quando o usuário pedir a lista completa.",
      entrada: {
        caminho: z.string(),
        base: zBase,
        parametros: zParametros,
        campos: zCampos,
        max_registros: z.number().int().positive().max(100000).default(20000),
        nome_arquivo: z.string().optional(),
      },
    },
    async ({ caminho, base, parametros, campos, max_registros, nome_arquivo }) => {
      const prazo = Date.now() + Math.max(cfg.timeoutFerramentaMs, 5 * 60 * 1000);
      const r = await consultor.consultar(base, caminho, parametros as Query, { maxRegistros: max_registros, prazo });
      const itens = r.forma === "lista" ? r.itens : [r.objeto];
      const destino = ctx.exportar(nome_arquivo ?? caminho, prepararItens(ctx, itens, caminho, campos));
      return {
        ...destino,
        registros: itens.length,
        total_no_sienge: r.total,
        chamadas_api: r.chamadas,
        ...(r.truncado ? { aviso: `Exportação limitada a ${itens.length} de ${r.total ?? "?"} registros (max_registros).` } : {}),
        ...(r.parcial ? { parcial: r.parcial } : {}),
      };
    },
  );
}

export function resumirBulk(
  ctx: Contexto,
  caminho: string,
  itens: unknown[],
  chamadas: number,
  o: { agrupar_por?: string; somar?: string[]; amostra?: number; campos?: string[]; exportar_csv?: boolean },
): Record<string, unknown> {
  const registros = itens as Record<string, unknown>[];
  const somas = Object.fromEntries((o.somar ?? []).map((c) => [c, registros.reduce((s, i) => s + numero(i[c]), 0)]));
  const resposta: Record<string, unknown> = {
    rota: `bulk-data ${caminho}`,
    registros: itens.length,
    chamadas_api: chamadas,
    ...(o.somar?.length ? { totais: Object.fromEntries(Object.entries(somas).map(([k, v]) => [k, Math.round(v * 100) / 100])) } : {}),
  };
  if (o.agrupar_por) {
    const medidas = Object.fromEntries((o.somar ?? []).map((c) => [c, (i: Record<string, unknown>) => numero(i[c])]));
    resposta.grupos = agrupar(registros, (i) => i[o.agrupar_por!] as string, medidas, 25);
  }
  if (o.exportar_csv) {
    Object.assign(resposta, ctx.exportar(`bulk-${caminho}`, prepararItens(ctx, itens, caminho, o.campos)));
  }
  const n = o.amostra ?? 20;
  if (n > 0) resposta.amostra = prepararItens(ctx, itens.slice(0, n), caminho, o.campos);
  if (itens.length > n) resposta.observacao = `Amostra de ${n} de ${itens.length} registros. Use agrupar_por/somar para totais ou exportar_csv para tudo.`;
  return resposta;
}
