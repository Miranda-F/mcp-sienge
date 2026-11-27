import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CACHE_CADASTROS, filtrarTexto, registrar, respostaLista, zId, type Contexto } from "./contexto.js";

type Registro = Record<string, unknown>;

export function registrarCadastros(servidor: McpServer, ctx: Contexto): void {
  const { consultor } = ctx;

  registrar(
    servidor,
    ctx,
    "sienge_empresas",
    {
      titulo: "Empresas",
      descricao: "Lista as empresas cadastradas no Sienge (id, nome, nome fantasia, CNPJ). Use para descobrir o empresa_id de outras consultas.",
      entrada: { busca: z.string().optional().describe("Filtra por nome ou nome fantasia") },
    },
    async ({ busca }) => {
      const r = await consultor.consultar("v1", "/companies", {}, { maxRegistros: 2000, cacheMs: CACHE_CADASTROS });
      r.itens = filtrarTexto(r.itens as Registro[], busca, ["name", "tradeName"]);
      return respostaLista(ctx, r, "/companies", ["id", "name", "tradeName", "cnpj"]);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_obras",
    {
      titulo: "Obras e empreendimentos",
      descricao:
        "Lista obras/empreendimentos (id, nome, empresa, tipo). Use para descobrir o obra_id/empreendimento_id. Tipo: 1=obra e centro de custo, 2=obra, 3=centro de custo, 4=centro de custo associado a obra.",
      entrada: {
        busca: z.string().optional().describe("Filtra por nome ou nome comercial"),
        empresa_id: zId.optional(),
        tipo: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
        obra_id: zId.optional().describe("Detalha uma obra específica"),
      },
    },
    async ({ busca, empresa_id, tipo, obra_id }) => {
      if (obra_id) {
        const r = await consultor.consultar("v1", `/enterprises/${obra_id}`, {}, { cacheMs: CACHE_CADASTROS });
        return respostaLista(ctx, r, `/enterprises/${obra_id}`);
      }
      const r = await consultor.consultar("v1", "/enterprises", { companyId: empresa_id, type: tipo }, { maxRegistros: 5000, cacheMs: CACHE_CADASTROS });
      r.itens = filtrarTexto(r.itens as Registro[], busca, ["name", "commercialName"]);
      return respostaLista(ctx, r, "/enterprises", ["id", "name", "commercialName", "companyId", "companyName", "type", "buildingTypeDescription", "cnpj"]);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_centros_custo",
    {
      titulo: "Centros de custo",
      descricao: "Lista centros de custo (id, nome, empresa). Use para descobrir o centro_custo_id.",
      entrada: { busca: z.string().optional() },
    },
    async ({ busca }) => {
      const r = await consultor.consultar("v1", "/cost-centers", {}, { maxRegistros: 5000, cacheMs: CACHE_CADASTROS });
      r.itens = filtrarTexto(r.itens as Registro[], busca, ["name"]);
      return respostaLista(ctx, r, "/cost-centers", ["id", "name", "idCompany", "cnpj"]);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_credores",
    {
      titulo: "Credores (fornecedores)",
      descricao: "Pesquisa credores/fornecedores por nome, CPF ou CNPJ, ou detalha um credor pelo id.",
      entrada: {
        nome: z.string().optional(),
        cpf: z.string().optional(),
        cnpj: z.string().optional(),
        credor_id: zId.optional(),
        max_registros: z.number().int().positive().max(1000).default(50),
      },
    },
    async ({ nome, cpf, cnpj, credor_id, max_registros }) => {
      if (credor_id) {
        const r = await consultor.consultar("v1", `/creditors/${credor_id}`, {});
        return respostaLista(ctx, r, `/creditors/${credor_id}`);
      }
      const r = await consultor.consultar(
        "v1",
        "/creditors",
        { creditor: nome, cpf, cnpj: cnpj ? [cnpj] : undefined },
        { maxRegistros: max_registros },
      );
      return respostaLista(ctx, r, "/creditors", ["id", "name", "tradeName", "cnpj", "cpf", "active", "supplier", "broker", "employee"]);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_clientes",
    {
      titulo: "Clientes",
      descricao:
        "Pesquisa clientes por CPF, CNPJ, empreendimento ou datas de cadastro, ou detalha um cliente pelo id. O filtro 'nome' é aplicado localmente sobre os registros retornados (a API não filtra por nome).",
      entrada: {
        cliente_id: zId.optional(),
        cpf: z.string().optional(),
        cnpj: z.string().optional(),
        empreendimento_id: zId.optional(),
        nome: z.string().optional(),
        somente_ativos: z.boolean().optional(),
        max_registros: z.number().int().positive().max(5000).default(200),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      if (a.cliente_id) {
        const r = await consultor.consultar("v1", `/customers/${a.cliente_id}`, {});
        return respostaLista(ctx, r, `/customers/${a.cliente_id}`);
      }
      const r = await consultor.consultar(
        "v1",
        "/customers",
        { cpf: a.cpf, cnpj: a.cnpj, enterpriseId: a.empreendimento_id, onlyActive: a.somente_ativos },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      r.itens = filtrarTexto(r.itens as Registro[], a.nome, ["name", "socialName", "fantasyName"]);
      return respostaLista(ctx, r, "/customers", ["id", "name", "personType", "cpf", "cnpj", "email", "clientType", "createdAt", "phones"]);
    },
  );
}
