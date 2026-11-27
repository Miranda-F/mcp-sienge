import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Auditoria } from "./auditoria.js";
import type { Config } from "./config.js";
import { Consultor } from "./consulta.js";
import { gravarCsv } from "./exportacao.js";
import { ClienteSienge, type OpcoesCliente } from "./http/cliente.js";
import { CatalogoRotas } from "./rotas.js";
import { registrarCadastros } from "./ferramentas/cadastros.js";
import type { Contexto } from "./ferramentas/contexto.js";
import { registrarFinanceiro } from "./ferramentas/financeiro.js";
import { registrarGenericas } from "./ferramentas/genericas.js";
import { registrarSuprimentos } from "./ferramentas/suprimentos.js";

export const VERSAO = "0.2.0";

const INSTRUCOES = `Servidor MCP SOMENTE LEITURA do ERP Sienge (construção civil). Nenhuma ferramenta altera dados.
Como usar:
- Descubra ids com sienge_empresas, sienge_obras, sienge_centros_custo, sienge_credores e sienge_clientes.
- Para totais e volumes grandes use as ferramentas de resumo (sienge_resumo_contas_pagar, sienge_resumo_contas_receber, sienge_inadimplencia): elas agregam no servidor.
- Para qualquer outra consulta, pesquise com sienge_rotas e execute com sienge_consultar.
- Para a lista completa de registros, use sienge_exportar_csv.
- Datas no formato AAAA-MM-DD. Valores monetários em reais.
- A API tem cota diária e limite por minuto: prefira filtros específicos e evite repetir consultas.`;

export interface OpcoesContexto extends OpcoesCliente {
  /**
   * Modo HTTP: o CSV fica no servidor e a ferramenta devolve um link de download
   * em vez do caminho local. Recebe o nome do arquivo e devolve a URL pública.
   */
  urlDownload?: (nomeArquivo: string) => string;
  catalogo?: CatalogoRotas;
}

/** Contexto compartilhado entre conexões (limite por minuto, cota e cache valem para todas). */
export function criarContexto(cfg: Config, opcoes: OpcoesContexto = {}): Contexto {
  const cliente = new ClienteSienge(cfg, opcoes);
  const catalogo = opcoes.catalogo ?? CatalogoRotas.carregar();
  return {
    cfg,
    consultor: new Consultor(cfg, cliente, catalogo),
    auditoria: new Auditoria(cfg.arquivoAuditoria),
    exportar: (nome, itens): Record<string, string> => {
      if (!opcoes.urlDownload) return { arquivo_csv: gravarCsv(cfg.pastaExportacao, nome, itens) };
      const arquivo = gravarCsv(cfg.pastaExportacao, nome, itens, new Date(), true);
      const base = arquivo.split(/[\\/]/).pop()!;
      return { link_csv: opcoes.urlDownload(base), validade: "24 horas" };
    },
  };
}

export function criarServidor(ctx: Contexto): McpServer {
  const servidor = new McpServer({ name: "mcp-sienge", version: VERSAO }, { instructions: INSTRUCOES });
  registrarGenericas(servidor, ctx);
  registrarCadastros(servidor, ctx);
  registrarFinanceiro(servidor, ctx);
  registrarSuprimentos(servidor, ctx);
  return servidor;
}
