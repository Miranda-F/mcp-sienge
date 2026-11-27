import type { Config } from "../config.js";
import { LimitadorPorMinuto } from "./limitador.js";
import { UsoDiario, type TipoApi } from "./uso-diario.js";

export type ValorQuery = string | number | boolean | Array<string | number> | null | undefined;
export type Query = Record<string, ValorQuery>;

export type TipoErro = "http" | "rede" | "cota" | "tempo" | "rota";

export class ErroSienge extends Error {
  constructor(
    message: string,
    readonly tipo: TipoErro,
    readonly status?: number,
    readonly campos?: Array<{ field?: string; message?: string }>,
  ) {
    super(message);
  }
}

export interface OpcoesCliente {
  fetch?: typeof fetch;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  uso?: UsoDiario;
}

export interface OpcoesGet {
  /** Instante (epoch ms) após o qual a chamada desiste. */
  prazo?: number;
  /** Tempo de cache da resposta em ms (0 = sem cache). */
  cacheMs?: number;
}

const CAMINHO_SEGURO = /^\/[A-Za-z0-9\-_.~/]*$/;
const STATUS_REPETIR = new Set([429, 500, 502, 503, 504]);
const TENTATIVAS = 4;

/**
 * Cliente HTTP do Sienge. Só existe o método GET: este servidor é somente leitura.
 */
export class ClienteSienge {
  private readonly fetch: typeof fetch;
  private readonly agora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly limitadores: Record<TipoApi, LimitadorPorMinuto>;
  private readonly cache = new Map<string, { expira: number; valor: unknown }>();
  readonly uso: UsoDiario;
  private readonly autorizacao: string;

  constructor(
    private readonly cfg: Config,
    opcoes: OpcoesCliente = {},
  ) {
    this.fetch = opcoes.fetch ?? globalThis.fetch;
    this.agora = opcoes.agora ?? Date.now;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.uso = opcoes.uso ?? new UsoDiario(cfg.pastaEstado, cfg.subdominio);
    this.limitadores = {
      rest: new LimitadorPorMinuto(cfg.limitePorMinutoRest, this.agora),
      bulk: new LimitadorPorMinuto(cfg.limitePorMinutoBulk, this.agora),
    };
    this.autorizacao = "Basic " + Buffer.from(`${cfg.usuario}:${cfg.senha}`).toString("base64");
  }

  montarUrl(tipo: TipoApi, caminho: string, query: Query = {}): string {
    if (!CAMINHO_SEGURO.test(caminho) || caminho.includes("..") || caminho.includes("//")) {
      throw new ErroSienge(`Caminho inválido: ${caminho}`, "rota");
    }
    const prefixo = tipo === "bulk" ? "bulk-data/v1" : "v1";
    const url = new URL(`${this.cfg.baseUrl}/${this.cfg.subdominio}/public/api/${prefixo}${caminho}`);
    for (const [chave, valor] of Object.entries(query)) {
      if (valor === undefined || valor === null || valor === "") continue;
      if (Array.isArray(valor)) for (const v of valor) url.searchParams.append(chave, String(v));
      else url.searchParams.append(chave, String(valor));
    }
    return url.toString();
  }

  cotaRestante(tipo: TipoApi): number | undefined {
    const cota = tipo === "rest" ? this.cfg.cotaDiariaRest : this.cfg.cotaDiariaBulk;
    return cota === undefined ? undefined : Math.max(0, cota - this.uso.usado(tipo));
  }

  async get(tipo: TipoApi, caminho: string, query: Query = {}, opcoes: OpcoesGet = {}): Promise<unknown> {
    const url = this.montarUrl(tipo, caminho, query);
    const prazo = opcoes.prazo ?? this.agora() + this.cfg.timeoutFerramentaMs;

    const emCache = this.cache.get(url);
    if (emCache && emCache.expira > this.agora()) return emCache.valor;

    let ultimoErro: ErroSienge | undefined;
    for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
      await this.aguardarVez(tipo, prazo);
      const restante = this.cotaRestante(tipo);
      if (restante === 0) {
        throw new ErroSienge(
          `Cota diária ${tipo.toUpperCase()} configurada (${tipo === "rest" ? this.cfg.cotaDiariaRest : this.cfg.cotaDiariaBulk}) já foi usada hoje.`,
          "cota",
        );
      }

      this.limitadores[tipo].registrar();
      let resposta: Response;
      try {
        const ms = Math.max(1000, Math.min(this.cfg.timeoutHttpMs, prazo - this.agora()));
        resposta = await this.fetch(url, {
          method: "GET",
          headers: { Authorization: this.autorizacao, Accept: "application/json" },
          signal: AbortSignal.timeout(ms),
        });
        // Só conta na cota o que chegou ao Sienge (qualquer status HTTP).
        this.uso.registrar(tipo);
      } catch (e) {
        const err = e as Error;
        const tempo = err.name === "TimeoutError" || err.name === "AbortError";
        ultimoErro = new ErroSienge(
          tempo ? "O Sienge demorou demais para responder." : `Falha de rede ao chamar o Sienge: ${err.message}`,
          tempo ? "tempo" : "rede",
        );
        if (!(await this.esperarParaRepetir(tentativa, undefined, prazo))) break;
        continue;
      }

      if (resposta.ok) {
        const valor = await lerCorpo(resposta);
        if (opcoes.cacheMs) this.cache.set(url, { expira: this.agora() + opcoes.cacheMs, valor });
        return valor;
      }

      ultimoErro = await erroDaResposta(resposta);
      if (!STATUS_REPETIR.has(resposta.status)) throw ultimoErro;
      if (!(await this.esperarParaRepetir(tentativa, resposta.headers.get("retry-after"), prazo))) break;
    }
    throw ultimoErro ?? new ErroSienge("Falha desconhecida ao chamar o Sienge.", "rede");
  }

  private async aguardarVez(tipo: TipoApi, prazo: number): Promise<void> {
    for (;;) {
      const espera = this.limitadores[tipo].espera();
      if (espera === 0) return;
      if (this.agora() + espera > prazo) {
        throw new ErroSienge(
          `Limite de ${tipo === "rest" ? this.cfg.limitePorMinutoRest : this.cfg.limitePorMinutoBulk} chamadas/minuto atingido; tente de novo em ${Math.ceil(espera / 1000)} s.`,
          "tempo",
          429,
        );
      }
      await this.dormir(espera);
    }
  }

  /** Espera antes de nova tentativa. Retorna false se não houver tempo até o prazo. */
  private async esperarParaRepetir(tentativa: number, retryAfter: string | null | undefined, prazo: number): Promise<boolean> {
    if (tentativa >= TENTATIVAS - 1) return false;
    let ms = 1000 * 2 ** tentativa + Math.floor(Math.random() * 250);
    if (retryAfter) {
      const s = Number(retryAfter);
      if (Number.isFinite(s)) ms = s * 1000;
      else {
        const data = Date.parse(retryAfter);
        if (Number.isFinite(data)) ms = Math.max(0, data - this.agora());
      }
    }
    if (this.agora() + ms > prazo) return false;
    await this.dormir(ms);
    return true;
  }
}

async function lerCorpo(resposta: Response): Promise<unknown> {
  if (resposta.status === 204) return null;
  const texto = await resposta.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

const DICAS: Record<number, string> = {
  400: "Parâmetros inválidos ou incompletos.",
  401: "Usuário ou senha da API recusados. Confira SIENGE_API_USER/SIENGE_API_PASSWORD (usuário do Painel de Integrações).",
  403: "O usuário da API não tem permissão para este recurso. Libere o módulo no Painel de Integrações.",
  404: "Recurso não encontrado (id inexistente ou rota indisponível neste Sienge).",
  422: "Os dados enviados têm problema de estrutura.",
  429: "Limite de requisições do Sienge excedido (por minuto ou cota diária do pacote).",
  500: "Erro interno no Sienge.",
  503: "Sienge temporariamente indisponível.",
};

async function erroDaResposta(resposta: Response): Promise<ErroSienge> {
  const corpo = await lerCorpo(resposta).catch(() => null);
  let mensagem = DICAS[resposta.status] ?? `Erro HTTP ${resposta.status}.`;
  let campos: ErroSienge["campos"];
  if (corpo && typeof corpo === "object") {
    const c = corpo as { clientMessage?: string; developerMessage?: string; errors?: ErroSienge["campos"] };
    const detalhe = c.clientMessage || c.developerMessage;
    if (detalhe) mensagem = `${mensagem} Sienge: ${detalhe}`;
    campos = Array.isArray(c.errors) ? c.errors : undefined;
  } else if (typeof corpo === "string" && corpo.trim()) {
    mensagem = `${mensagem} Sienge: ${corpo.trim().slice(0, 300)}`;
  }
  return new ErroSienge(mensagem, "http", resposta.status, campos);
}
