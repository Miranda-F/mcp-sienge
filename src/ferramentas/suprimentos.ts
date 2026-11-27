import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agrupar, numero, somar } from "../agregacao.js";
import { prepararItens, registrar, respostaLista, periodoPadrao, zData, zId, type Contexto } from "./contexto.js";

type Registro = Record<string, unknown>;

const CAMPOS_PEDIDO = [
  "id",
  "formattedPurchaseOrderId",
  "date",
  "status",
  "authorized",
  "disapproved",
  "deliveryLate",
  "consistent",
  "supplierId",
  "buildingId",
  "buyerId",
  "costCenterId",
  "totalAmount",
  "paymentCondition",
  "notes",
];

export function registrarSuprimentos(servidor: McpServer, ctx: Contexto): void {
  const { consultor } = ctx;

  registrar(
    servidor,
    ctx,
    "sienge_pedidos_compra",
    {
      titulo: "Listar pedidos de compra",
      descricao:
        "Lista pedidos de compra por período (data do pedido), situação, autorização, fornecedor, obra ou comprador, com total por situação e por fornecedor.",
      entrada: {
        data_inicio: zData.optional(),
        data_fim: zData.optional(),
        situacao: z.enum(["PENDING", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELED"]).optional().describe("PENDING=pendente, PARTIALLY_DELIVERED=parcialmente entregue, FULLY_DELIVERED=totalmente atendido, CANCELED=cancelado"),
        autorizado: z.boolean().optional(),
        aprovacao: z.enum(["APPROVED", "DISAPPROVED"]).optional(),
        fornecedor_id: zId.optional(),
        obra_id: zId.optional(),
        comprador: z.string().optional().describe("Id do comprador (usuário do Sienge)"),
        max_registros: z.number().int().positive().max(2000).default(200),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const caminho = "/purchase-orders";
      const r = await consultor.consultar(
        "v1",
        caminho,
        {
          startDate: p.inicio,
          endDate: p.fim,
          status: a.situacao,
          authorized: a.autorizado,
          statusApproval: a.aprovacao,
          supplierId: a.fornecedor_id,
          buildingId: a.obra_id,
          buyerId: a.comprador,
        },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      const itens = r.itens as Registro[];
      const valor = (i: Registro) => numero(i.totalAmount);
      return respostaLista(ctx, r, caminho, CAMPOS_PEDIDO, {
        periodo: p,
        valor_total_retornado: somar(itens, valor),
        por_situacao: agrupar(itens, (i) => i.status as string, { valor }, 10),
        por_fornecedor: agrupar(itens, (i) => i.supplierId as number, { valor }, 10),
      });
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_pedido_compra_detalhe",
    {
      titulo: "Detalhe de um pedido de compra",
      descricao: "Mostra um pedido de compra com itens, totalização e, se pedido, as previsões de entrega e as solicitações atendidas de cada item.",
      entrada: {
        pedido_id: zId,
        com_entregas: z.boolean().default(false).describe("Busca as previsões de entrega de cada item (1 chamada por item, até 30 itens)"),
      },
    },
    async ({ pedido_id, com_entregas }) => {
      const base = `/purchase-orders/${pedido_id}`;
      const [pedido, itens, totalizacao] = await Promise.all([
        consultor.consultar("v1", base, {}),
        consultor.consultar("v1", `${base}/items`, {}),
        consultor.consultar("v1", `${base}/totalization`, {}),
      ]);
      const listaItens = itens.itens as Registro[];
      const resposta: Record<string, unknown> = {
        pedido: prepararItens(ctx, [pedido.forma === "objeto" ? pedido.objeto : pedido.itens[0]], base)[0],
        totalizacao: prepararItens(ctx, [totalizacao.forma === "objeto" ? totalizacao.objeto : totalizacao.itens[0]], base)[0],
        quantidade_itens: listaItens.length,
        itens: prepararItens(ctx, listaItens, base, [
          "itemNumber",
          "resourceCode",
          "resourceDescription",
          "detailDescription",
          "trademarkDescription",
          "unitOfMeasure",
          "quantity",
          "unitPrice",
          "netPrice",
          "discount",
          "notes",
        ]),
      };
      if (com_entregas) {
        resposta.entregas = await Promise.all(
          listaItens.slice(0, 30).map(async (i) => {
            const e = await consultor.consultar("v1", `${base}/items/${i.itemNumber}/delivery-schedules`, {});
            return { item: i.itemNumber, previsoes: prepararItens(ctx, e.forma === "objeto" ? [e.objeto] : e.itens, base) };
          }),
        );
      }
      return resposta;
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_solicitacoes_compra",
    {
      titulo: "Itens de solicitações de compra",
      descricao:
        "Lista itens de solicitações de compra por período, obra, solicitante, autorização e situação. Útil para 'o que está pendente de compra na obra X' ou 'solicitações aguardando autorização'.",
      entrada: {
        solicitacao_id: zId.optional(),
        data_inicio: zData.optional(),
        data_fim: zData.optional(),
        obra_id: zId.optional(),
        solicitante: z.string().optional(),
        autorizado: z.boolean().optional(),
        reprovado: z.boolean().optional(),
        situacao: z.enum(["PENDING", "PARTIALLY_ATTENDED", "FULLY_ATTENDED", "CANCELED"]).optional(),
        com_quantidade_em_aberto: z.boolean().optional(),
        max_registros: z.number().int().positive().max(2000).default(200),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      const caminho = "/purchase-requests/all/items";
      const r = await consultor.consultar(
        "v1",
        caminho,
        {
          purchaseRequestId: a.solicitacao_id,
          startDate: a.data_inicio,
          endDate: a.data_fim,
          buildingId: a.obra_id,
          requesterUser: a.solicitante,
          authorized: a.autorizado,
          disapproved: a.reprovado,
          purchaseRequestStatus: a.situacao,
          withOpenQuantity: a.com_quantidade_em_aberto,
        },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      return respostaLista(ctx, r, caminho, [
        "purchaseRequestId",
        "itemNumber",
        "productId",
        "productDescription",
        "detailDescription",
        "quantity",
        "unitySymbol",
        "estimatedPrice",
        "authorized",
        "disapproved",
        "disapprovalReason",
        "estimatedDeliveryTime",
        "notes",
      ]);
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_contratos_suprimentos",
    {
      titulo: "Contratos de suprimentos",
      descricao: "Lista contratos de suprimentos/serviços pela data do contrato, com filtros por empresa, obra, aprovação e autorização.",
      entrada: {
        data_inicio: zData.optional().describe("Data do contrato a partir de (padrão: início do mês atual)"),
        data_fim: zData.optional(),
        empresa_id: zId.optional(),
        obra_id: zId.optional(),
        aprovacao: z.enum(["A", "D"]).optional().describe("A=aprovado, D=desaprovado"),
        autorizacao: z.enum(["T", "S", "A", "N"]).optional().describe("T=todos, S=reprovados, A=aprovados, N=aguardando autorização"),
        max_registros: z.number().int().positive().max(2000).default(200),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a) => {
      const p = periodoPadrao(a.data_inicio, a.data_fim);
      const caminho = "/supply-contracts/all";
      const r = await consultor.consultar(
        "v1",
        caminho,
        {
          contractStartDate: p.inicio,
          contractEndDate: p.fim,
          companyId: a.empresa_id,
          buildingId: a.obra_id,
          statusApproval: a.aprovacao,
          authorization: a.autorizacao,
        },
        { maxRegistros: a.max_registros, offset: a.offset },
      );
      return respostaLista(ctx, r, caminho, undefined, { periodo: p });
    },
  );

  registrar(
    servidor,
    ctx,
    "sienge_estoque",
    {
      titulo: "Estoque de insumos",
      descricao: "Insumos em estoque de um centro de custo (obra/almoxarifado), com filtro local por descrição.",
      entrada: {
        centro_custo_id: zId,
        busca: z.string().optional().describe("Filtra pela descrição do insumo"),
        max_registros: z.number().int().positive().max(5000).default(1000),
      },
    },
    async (a) => {
      const caminho = `/stock-inventories/${a.centro_custo_id}/items`;
      const r = await consultor.consultar("v1", caminho, {}, { maxRegistros: a.max_registros });
      if (a.busca && r.forma === "lista") {
        const alvo = a.busca.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        r.itens = r.itens.filter((i) => JSON.stringify(i).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(alvo));
      }
      return respostaLista(ctx, r, caminho);
    },
  );
}
