import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Auditoria } from "../auditoria.js";
import type { Config } from "../config.js";
import type { Consultor, ResultadoConsulta } from "../consulta.js";
import { ErroSienge } from "../http/cliente.js";
import { ehRotaBancaria, enxugar, mascarar, projetar, serializar } from "../saida.js";
import { hojeBrasil } from "../agregacao.js";

export interface Contexto {
  cfg: Config;
  consultor: Consultor;
  auditoria: Auditoria;
  /** Grava CSV e devolve onde encontrá-lo: caminho local (stdio) ou link de download (HTTP). */
  exportar: (nome: string, itens: unknown[]) => Record<string, string>;
}

export const ANOTACOES_LEITURA = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const zData = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD");
export const zId = z.number().int().positive();

/** Seis horas: cadastros que mudam pouco. */
export const CACHE_CADASTROS = 6 * 60 * 60 * 1000;

export function erroTexto(e: unknown): string {
  if (e instanceof ErroSienge) {
    const campos = e.campos?.length ? ` Campos: ${e.campos.map((c) => `${c.field ?? "?"}: ${c.message ?? ""}`).join("; ")}` : "";
    return `${e.message}${campos}`;
  }
  return `Erro inesperado: ${(e as Error)?.message ?? String(e)}`;
}

/**
 * Registra uma ferramenta somente leitura com auditoria e tratamento de erro padronizados.
 * O handler devolve um objeto, que vira JSON compacto (respeitando o limite de tamanho).
 */
export function registrar<Shape extends z.ZodRawShape>(
  servidor: McpServer,
  ctx: Contexto,
  nome: string,
  definicao: { titulo: string; descricao: string; entrada: Shape },
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<Record<string, unknown>>,
): void {
  servidor.registerTool(
    nome,
    {
      title: definicao.titulo,
      description: definicao.descricao,
      inputSchema: definicao.entrada,
      annotations: { title: definicao.titulo, ...ANOTACOES_LEITURA },
    },
    (async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      const inicio = Date.now();
      try {
        const resposta = await handler(args);
        ctx.auditoria.registrar({ ferramenta: nome, argumentos: args, resultado: "ok", duracaoMs: Date.now() - inicio });
        return { content: [{ type: "text", text: serializar(resposta, ctx.cfg.maxCaracteresResposta) }] };
      } catch (e) {
        const msg = erroTexto(e);
        ctx.auditoria.registrar({ ferramenta: nome, argumentos: args, resultado: "erro", duracaoMs: Date.now() - inicio, erro: msg });
        return { isError: true, content: [{ type: "text", text: msg }] };
      }
    }) as never,
  );
}

/** Aplica limpeza, máscara e projeção aos itens de uma consulta. */
export function prepararItens(ctx: Contexto, itens: unknown[], caminho: string, campos?: string[]): unknown[] {
  let saida = projetar(itens, campos);
  if (ctx.cfg.mascararDadosPessoais) saida = mascarar(saida, ehRotaBancaria(caminho)) as unknown[];
  return enxugar(saida) as unknown[];
}

/** Monta a resposta padrão de uma lista paginada. */
export function respostaLista(
  ctx: Contexto,
  r: ResultadoConsulta,
  caminho: string,
  campos?: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (r.forma === "objeto") {
    const obj = ctx.cfg.mascararDadosPessoais ? mascarar(r.objeto, ehRotaBancaria(caminho)) : r.objeto;
    return { rota: `${r.rota.base === "bulk" ? "bulk-data " : ""}${caminho}`, chamadas_api: r.chamadas, ...extra, dados: enxugar(obj) };
  }
  const avisos: string[] = [];
  if (r.truncado) {
    avisos.push(
      `Há mais registros: ${r.total ?? "?"} no total, ${r.itens.length} retornados. Para continuar, repita com offset=${r.proximoOffset}; para totais use uma ferramenta de resumo; para a lista completa use sienge_exportar_csv.`,
    );
  }
  if (r.parcial) avisos.push(`Resultado parcial: ${r.parcial}`);
  return {
    rota: `${r.rota.base === "bulk" ? "bulk-data " : ""}${caminho}`,
    total_no_sienge: r.total,
    retornados: r.itens.length,
    offset: r.offset,
    proximo_offset: r.proximoOffset,
    chamadas_api: r.chamadas,
    ...(avisos.length ? { avisos } : {}),
    ...extra,
    itens: prepararItens(ctx, r.itens, caminho, campos),
  };
}

/** Período padrão: mês corrente (do dia 1 ao último dia), no fuso de Brasília. */
export function periodoPadrao(inicio?: string, fim?: string): { inicio: string; fim: string; padrao: boolean } {
  if (inicio && fim) return { inicio, fim, padrao: false };
  const hoje = hojeBrasil();
  const [a, m] = hoje.split("-").map(Number) as [number, number];
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return {
    inicio: inicio ?? `${a}-${mm}-01`,
    fim: fim ?? `${a}-${mm}-${String(ultimo).padStart(2, "0")}`,
    padrao: true,
  };
}

/** Filtro de texto local (sem acento, sem caixa) sobre campos de nome. */
export function filtrarTexto<T>(itens: T[], texto: string | undefined, campos: (keyof T)[]): T[] {
  if (!texto) return itens;
  const alvo = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return itens.filter((i) =>
    campos.some((c) =>
      String(i[c] ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .includes(alvo),
    ),
  );
}
