import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { carregarConfig, type Config } from "../src/config.js";

export interface Requisicao {
  metodo: string;
  caminho: string;
  query: URLSearchParams;
  autorizacao?: string;
}

export type Manipulador = (req: Requisicao) => { status?: number; corpo?: unknown; headers?: Record<string, string> };

/** Sienge falso: responde conforme um mapa "caminho" -> manipulador e registra todas as requisições. */
export class SiengeFake {
  readonly requisicoes: Requisicao[] = [];
  private servidor?: Server;
  private rotas = new Map<string, Manipulador>();

  rota(caminho: string, m: Manipulador): this {
    this.rotas.set(caminho, m);
    return this;
  }

  async iniciar(): Promise<string> {
    this.servidor = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      const r: Requisicao = {
        metodo: req.method ?? "?",
        caminho: url.pathname,
        query: url.searchParams,
        autorizacao: req.headers.authorization,
      };
      this.requisicoes.push(r);
      const m = this.rotas.get(url.pathname);
      const resp = m ? m(r) : { status: 404, corpo: { status: 404, clientMessage: "não encontrado" } };
      res.writeHead(resp.status ?? 200, { "content-type": "application/json", ...(resp.headers ?? {}) });
      res.end(resp.corpo === undefined ? "" : JSON.stringify(resp.corpo));
    });
    await new Promise<void>((ok) => this.servidor!.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(this.servidor!.address() as AddressInfo).port}`;
  }

  async parar(): Promise<void> {
    await new Promise<void>((ok) => this.servidor?.close(() => ok()));
  }
}

export const REST = "/teste/public/api/v1";
export const BULK = "/teste/public/api/bulk-data/v1";

export function configTeste(baseUrl: string, extra: Record<string, string> = {}): Config {
  return carregarConfig({
    SIENGE_SUBDOMAIN: "teste",
    SIENGE_API_USER: "usuario-api",
    SIENGE_API_PASSWORD: "senha",
    SIENGE_BASE_URL: baseUrl,
    SIENGE_LOG: "off",
    SIENGE_STATE_DIR: "",
    ...extra,
  });
}

/** Gera uma resposta paginada a partir de uma lista completa. */
export function paginar(todos: unknown[]): Manipulador {
  return (req) => {
    const limit = Number(req.query.get("limit") ?? 100);
    const offset = Number(req.query.get("offset") ?? 0);
    return { corpo: { resultSetMetadata: { count: todos.length, offset, limit }, results: todos.slice(offset, offset + limit) } };
  };
}
