import { readFileSync } from "node:fs";
import type { TipoApi } from "./http/uso-diario.js";
import { ErroSienge, type Query, type ValorQuery } from "./http/cliente.js";

export interface Parametro {
  nome: string;
  em: "query" | "path";
  obrigatorio: boolean;
  tipo: string;
  valores?: unknown[];
  descricao?: string;
}

export interface Rota {
  id: string;
  base: "v1" | "bulk";
  caminho: string;
  modulo: string;
  area: string;
  arquivo: string;
  resumo: string;
  descricao?: string;
  paginado: boolean;
  parametros: Parametro[];
  campos?: string[];
  bloqueado?: string;
}

interface RotaCompilada extends Rota {
  regex: RegExp;
  nomesPath: string[];
}

/** Parâmetros que o próprio servidor controla e que a IA não pode enviar. */
const RESERVADOS = new Set(["_async", "_asyncChunkMaxSize", "_asyncWebHookUrl", "_asyncWebHookToken"]);

export function tipoApi(base: Rota["base"]): TipoApi {
  return base === "bulk" ? "bulk" : "rest";
}

function compilar(r: Rota): RotaCompilada {
  const nomesPath: string[] = [];
  const padrao = r.caminho
    .split("/")
    .map((seg) => {
      const m = seg.match(/^\{(.+)\}$/);
      if (m) {
        nomesPath.push(m[1]!);
        return "([A-Za-z0-9\\-_.~]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...r, regex: new RegExp(`^${padrao}$`), nomesPath };
}

export class CatalogoRotas {
  private readonly rotas: RotaCompilada[];

  constructor(rotas: Rota[]) {
    // Rotas fixas antes das com parâmetro, para "/bills/by-change-date" não casar com "/bills/{billId}".
    this.rotas = rotas
      .map(compilar)
      .sort((a, b) => a.nomesPath.length - b.nomesPath.length || b.caminho.length - a.caminho.length);
  }

  static carregar(): CatalogoRotas {
    const url = new URL("./generated/rotas.json", import.meta.url);
    return new CatalogoRotas(JSON.parse(readFileSync(url, "utf8")) as Rota[]);
  }

  todas(): Rota[] {
    return this.rotas;
  }

  porId(id: string): Rota | undefined {
    return this.rotas.find((r) => r.id === id);
  }

  /** Encontra a rota do catálogo que corresponde a um caminho concreto (ex.: /bills/123/installments). */
  encontrar(base: Rota["base"], caminho: string): { rota: Rota; valoresPath: Record<string, string> } | undefined {
    const limpo = caminho.split("?")[0]!.replace(/\/+$/, "") || "/";
    for (const r of this.rotas) {
      if (r.base !== base) continue;
      const m = limpo.match(r.regex);
      if (m) return { rota: r, valoresPath: Object.fromEntries(r.nomesPath.map((n, i) => [n, m[i + 1]!])) };
    }
    return undefined;
  }

  /**
   * Valida uma consulta contra o catálogo: a rota precisa existir, não estar bloqueada,
   * e só pode receber parâmetros de query documentados.
   */
  validar(base: Rota["base"], caminho: string, query: Query): Rota {
    if (caminho.includes("..") || /[?#%\\]/.test(caminho)) {
      throw new ErroSienge(`Caminho inválido: ${caminho}. Informe só o caminho, sem query string.`, "rota");
    }
    const achado = this.encontrar(base, caminho);
    if (!achado) {
      throw new ErroSienge(
        `A rota ${base === "bulk" ? "bulk-data " : ""}${caminho} não está na lista de consultas GET permitidas. Use sienge_rotas para pesquisar as rotas disponíveis.`,
        "rota",
      );
    }
    const { rota } = achado;
    if (rota.bloqueado) {
      throw new ErroSienge(`A rota ${rota.caminho} está desabilitada nesta versão (${rota.bloqueado}).`, "rota");
    }
    const aceitos = new Set(rota.parametros.filter((p) => p.em === "query").map((p) => p.nome));
    const desconhecidos = Object.keys(query).filter((k) => !aceitos.has(k) || RESERVADOS.has(k));
    if (desconhecidos.length) {
      throw new ErroSienge(
        `Parâmetro(s) não aceitos por ${rota.caminho}: ${desconhecidos.join(", ")}. Aceitos: ${[...aceitos].filter((a) => !RESERVADOS.has(a)).join(", ") || "nenhum"}.`,
        "rota",
      );
    }
    const faltando = rota.parametros.filter((p) => p.em === "query" && p.obrigatorio && vazio(query[p.nome]));
    if (faltando.length) {
      throw new ErroSienge(
        `Parâmetro(s) obrigatório(s) ausente(s) em ${rota.caminho}: ${faltando.map((p) => `${p.nome} (${p.descricao ?? p.tipo})`).join("; ")}.`,
        "rota",
      );
    }
    return rota;
  }

  pesquisar(filtro: { texto?: string; area?: string; base?: Rota["base"]; incluirBloqueadas?: boolean }): Rota[] {
    const termos = normalizar(filtro.texto ?? "").split(/\s+/).filter(Boolean);
    const area = normalizar(filtro.area ?? "");
    return this.rotas.filter((r) => {
      if (!filtro.incluirBloqueadas && r.bloqueado) return false;
      if (filtro.base && r.base !== filtro.base) return false;
      if (area && !normalizar(r.area).includes(area)) return false;
      if (!termos.length) return true;
      const alvo = normalizar(`${r.caminho} ${r.modulo} ${r.resumo} ${r.descricao ?? ""}`);
      return termos.every((t) => alvo.includes(t));
    });
  }
}

function vazio(v: ValorQuery): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
