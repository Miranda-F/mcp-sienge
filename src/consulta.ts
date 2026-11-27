import type { Config } from "./config.js";
import { ClienteSienge, ErroSienge, type Query } from "./http/cliente.js";
import { CatalogoRotas, tipoApi, type Rota } from "./rotas.js";

const TAMANHO_PAGINA = 200;

export interface ResultadoConsulta {
  rota: Rota;
  /** "lista" quando a resposta é uma coleção; "objeto" para respostas únicas. */
  forma: "lista" | "objeto";
  itens: unknown[];
  objeto?: unknown;
  /** Total de registros que o Sienge informou para a pesquisa (quando paginado). */
  total: number | null;
  offset: number;
  proximoOffset: number | null;
  truncado: boolean;
  chamadas: number;
  parcial?: string;
}

export interface OpcoesConsulta {
  maxRegistros?: number;
  offset?: number;
  prazo?: number;
  cacheMs?: number;
}

/** Acha a coleção dentro de uma resposta do Sienge ({results}, {data}, ou o primeiro array). */
export function extrairLista(corpo: unknown): { lista: unknown[]; total: number | null } | null {
  if (Array.isArray(corpo)) return { lista: corpo, total: corpo.length };
  if (!corpo || typeof corpo !== "object") return null;
  const o = corpo as Record<string, unknown>;
  const meta = o.resultSetMetadata as { count?: number } | undefined;
  const total = typeof meta?.count === "number" ? meta.count : null;
  for (const chave of ["results", "data"]) {
    if (Array.isArray(o[chave])) return { lista: o[chave] as unknown[], total: total ?? (o[chave] as unknown[]).length };
  }
  if (meta) {
    const arr = Object.entries(o).find(([k, v]) => k !== "resultSetMetadata" && Array.isArray(v));
    if (arr) return { lista: arr[1] as unknown[], total: total ?? (arr[1] as unknown[]).length };
  }
  return null;
}

export class Consultor {
  constructor(
    readonly cfg: Config,
    readonly cliente: ClienteSienge,
    readonly catalogo: CatalogoRotas,
  ) {}

  prazoPadrao(): number {
    return Date.now() + this.cfg.timeoutFerramentaMs;
  }

  /**
   * Executa uma consulta GET validada pelo catálogo. Em rotas paginadas, busca páginas
   * de 200 até `maxRegistros` (ou até o prazo), e devolve o total informado pelo Sienge.
   */
  async consultar(base: Rota["base"], caminho: string, query: Query, opcoes: OpcoesConsulta = {}): Promise<ResultadoConsulta> {
    const rota = this.catalogo.validar(base, caminho, query);
    const tipo = tipoApi(base);
    const prazo = opcoes.prazo ?? this.prazoPadrao();
    const maxRegistros = Math.max(1, opcoes.maxRegistros ?? this.cfg.maxRegistros);
    const offsetInicial = Math.max(0, opcoes.offset ?? 0);

    if (!rota.paginado) {
      const corpo = await this.cliente.get(tipo, caminho, query, { prazo, cacheMs: opcoes.cacheMs });
      const lista = extrairLista(corpo);
      if (!lista) {
        return { rota, forma: "objeto", itens: [], objeto: corpo, total: null, offset: 0, proximoOffset: null, truncado: false, chamadas: 1 };
      }
      const itens = lista.lista.slice(offsetInicial, offsetInicial + maxRegistros);
      const fim = offsetInicial + itens.length;
      return {
        rota,
        forma: "lista",
        itens,
        total: lista.lista.length,
        offset: offsetInicial,
        proximoOffset: fim < lista.lista.length ? fim : null,
        truncado: fim < lista.lista.length,
        chamadas: 1,
      };
    }

    const itens: unknown[] = [];
    let total: number | null = null;
    let offset = offsetInicial;
    let chamadas = 0;
    let parcial: string | undefined;
    let objetoUnico: unknown;

    while (itens.length < maxRegistros) {
      const limite = Math.min(TAMANHO_PAGINA, maxRegistros - itens.length);
      let corpo: unknown;
      try {
        corpo = await this.cliente.get(tipo, caminho, { ...query, limit: limite, offset }, { prazo, cacheMs: opcoes.cacheMs });
      } catch (e) {
        // Se já temos dados, devolve o que foi obtido em vez de perder tudo.
        if (chamadas > 0 && e instanceof ErroSienge && (e.tipo === "tempo" || e.tipo === "cota" || e.status === 429)) {
          parcial = e.message;
          break;
        }
        throw e;
      }
      chamadas++;
      const lista = extrairLista(corpo);
      if (!lista) {
        objetoUnico = corpo;
        break;
      }
      total = lista.total;
      itens.push(...lista.lista);
      offset += lista.lista.length;
      if (lista.lista.length < limite || (total !== null && offset >= total)) break;
    }

    if (objetoUnico !== undefined && itens.length === 0) {
      return { rota, forma: "objeto", itens: [], objeto: objetoUnico, total: null, offset: 0, proximoOffset: null, truncado: false, chamadas };
    }
    const haMais = total !== null ? offset < total : itens.length >= maxRegistros;
    return {
      rota,
      forma: "lista",
      itens,
      total,
      offset: offsetInicial,
      proximoOffset: haMais ? offset : null,
      truncado: haMais,
      chamadas,
      ...(parcial ? { parcial } : {}),
    };
  }

  /**
   * Bulk Data assíncrono: dispara a extração, acompanha o status por GET e baixa as partes.
   * Se o prazo acabar antes de terminar, devolve o identificador para consulta posterior.
   */
  async bulkAssincrono(
    caminho: string,
    query: Query,
    prazo = this.prazoPadrao(),
  ): Promise<{ concluido: true; itens: unknown[]; chamadas: number } | { concluido: false; identificador: string; status: string; chamadas: number }> {
    this.catalogo.validar("bulk", caminho, query);
    const inicio = (await this.cliente.get("bulk", caminho, { ...query, _async: true }, { prazo })) as { identifier?: string };
    if (!inicio?.identifier) throw new ErroSienge("O Sienge não devolveu o identificador da extração assíncrona.", "http");
    const r = await this.acompanharBulk(inicio.identifier, prazo);
    return { ...r, chamadas: r.chamadas + 1 };
  }

  async acompanharBulk(
    identificador: string,
    prazo = this.prazoPadrao(),
  ): Promise<{ concluido: true; itens: unknown[]; chamadas: number } | { concluido: false; identificador: string; status: string; chamadas: number }> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(identificador)) throw new ErroSienge("Identificador de extração inválido.", "rota");
    const esperas = [2000, 3000, 5000, 8000, 10000];
    let chamadas = 0;
    for (let i = 0; ; i++) {
      const st = (await this.cliente.get("bulk", `/async/${identificador}`, {}, { prazo })) as {
        status?: string;
        chunks?: number;
        error?: string;
      };
      chamadas++;
      if (st?.status === "Finished") {
        const itens: unknown[] = [];
        for (let parte = 1; parte <= (st.chunks ?? 1); parte++) {
          const corpo = await this.cliente.get("bulk", `/async/${identificador}/result/${parte}`, {}, { prazo });
          chamadas++;
          itens.push(...(extrairLista(corpo)?.lista ?? []));
        }
        return { concluido: true, itens, chamadas };
      }
      if (st?.status === "Failed") throw new ErroSienge(`A extração falhou no Sienge: ${st.error ?? "sem detalhes"}`, "http");
      const espera = esperas[Math.min(i, esperas.length - 1)]!;
      if (Date.now() + espera > prazo) {
        return { concluido: false, identificador, status: st?.status ?? "desconhecido", chamadas };
      }
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}
