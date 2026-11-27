import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, statSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { usuarioAtual } from "./auditoria.js";
import type { Config } from "./config.js";
import { ErroConfiguracao } from "./config.js";
import { criarContexto, criarServidor, VERSAO, type OpcoesContexto } from "./servidor.js";

export interface ConfigHttp {
  porta: number;
  /** URL pública (ex.: https://sienge-mcp.minhaempresa.com.br), usada nos links de CSV. */
  urlPublica: string;
  /** Tokens aceitos: nome -> token. */
  tokens: Map<string, string>;
}

const VALIDADE_CSV_MS = 24 * 60 * 60 * 1000;
const NOME_CSV = /^[A-Za-z0-9_-]+_[0-9a-f]{32}\.csv$/;
const LIMITE_CORPO = 1024 * 1024;

/**
 * MCP_AUTH_TOKENS aceita "token" ou "nome:token" separados por vírgula.
 * Cada token precisa ter pelo menos 32 caracteres.
 */
export function carregarConfigHttp(env: NodeJS.ProcessEnv = process.env): ConfigHttp {
  const bruto = (env.MCP_AUTH_TOKENS ?? "").trim();
  if (!bruto) throw new ErroConfiguracao("MCP_AUTH_TOKENS é obrigatório no modo HTTP (gere com: openssl rand -hex 32)");
  const tokens = new Map<string, string>();
  bruto.split(",").forEach((parte, i) => {
    const p = parte.trim();
    const sep = p.indexOf(":");
    const [nome, token] = sep > 0 ? [p.slice(0, sep).trim(), p.slice(sep + 1).trim()] : [`token${i + 1}`, p];
    if (token.length < 32) throw new ErroConfiguracao(`O token "${nome}" em MCP_AUTH_TOKENS precisa ter pelo menos 32 caracteres`);
    tokens.set(nome, token);
  });
  const porta = Number(env.PORT || env.MCP_PORT || 3000);
  if (!Number.isInteger(porta) || porta <= 0) throw new ErroConfiguracao("PORT inválida");
  const urlPublica = (env.MCP_PUBLIC_URL || `http://localhost:${porta}`).replace(/\/+$/, "");
  return { porta, urlPublica, tokens };
}

function hash(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Compara o token recebido com os configurados em tempo constante. Devolve o nome do token. */
export function autenticar(req: IncomingMessage, tokens: Map<string, string>): string | null {
  const auth = req.headers.authorization ?? "";
  const recebido = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : String(req.headers["x-api-key"] ?? "").trim();
  if (!recebido) return null;
  const h = hash(recebido);
  let achado: string | null = null;
  for (const [nome, token] of tokens) if (timingSafeEqual(h, hash(token))) achado = nome;
  return achado;
}

function json(res: ServerResponse, status: number, corpo: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(corpo));
}

async function lerCorpo(req: IncomingMessage): Promise<unknown> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const p of req) {
    tamanho += (p as Buffer).length;
    if (tamanho > LIMITE_CORPO) throw new Error("corpo grande demais");
    partes.push(p as Buffer);
  }
  const texto = Buffer.concat(partes).toString("utf8");
  return texto ? JSON.parse(texto) : undefined;
}

/** Bloqueio simples de força bruta: mais de 20 falhas de autenticação por minuto por IP. */
class Tentativas {
  private falhas = new Map<string, number[]>();
  bloqueado(ip: string): boolean {
    const agora = Date.now();
    const lista = (this.falhas.get(ip) ?? []).filter((t) => agora - t < 60_000);
    this.falhas.set(ip, lista);
    return lista.length >= 20;
  }
  falhou(ip: string): void {
    this.falhas.set(ip, [...(this.falhas.get(ip) ?? []), Date.now()]);
  }
}

function limparCsvsAntigos(pasta: string): void {
  try {
    for (const nome of readdirSync(pasta)) {
      if (!nome.endsWith(".csv")) continue;
      const caminho = join(pasta, nome);
      if (Date.now() - statSync(caminho).mtimeMs > VALIDADE_CSV_MS) unlinkSync(caminho);
    }
  } catch {
    /* pasta ainda não existe */
  }
}

export function criarServidorHttp(cfg: Config, http: ConfigHttp, opcoes: OpcoesContexto = {}): Server {
  // Um único contexto para todas as conexões: limite por minuto, cota e cache são compartilhados.
  const ctx = criarContexto(cfg, { ...opcoes, urlDownload: (nome) => `${http.urlPublica}/exportacoes/${nome}` });
  const tentativas = new Tentativas();

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]!.trim();
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return json(res, 200, { ok: true, servico: "mcp-sienge", versao: VERSAO, modo: "somente leitura" });
      }

      // Download de CSV exportado: o nome tem 128 bits aleatórios e expira em 24 h.
      if (url.pathname.startsWith("/exportacoes/") && req.method === "GET") {
        const nome = url.pathname.slice("/exportacoes/".length);
        if (!NOME_CSV.test(nome)) return json(res, 404, { erro: "não encontrado" });
        const caminho = join(cfg.pastaExportacao, nome);
        let st;
        try {
          st = statSync(caminho);
        } catch {
          return json(res, 404, { erro: "não encontrado ou expirado" });
        }
        if (Date.now() - st.mtimeMs > VALIDADE_CSV_MS) return json(res, 410, { erro: "link expirado" });
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${nome.replace(/_[0-9a-f]{32}\.csv$/, ".csv")}"`,
          "cache-control": "no-store",
        });
        createReadStream(caminho).pipe(res);
        return;
      }

      if (url.pathname !== "/mcp") return json(res, 404, { erro: "não encontrado" });

      if (tentativas.bloqueado(ip)) return json(res, 429, { erro: "muitas tentativas de autenticação; aguarde 1 minuto" });
      const usuario = autenticar(req, http.tokens);
      if (!usuario) {
        tentativas.falhou(ip);
        return json(res, 401, { erro: "token ausente ou inválido" }, { "www-authenticate": 'Bearer realm="mcp-sienge"' });
      }

      // Modo sem sessão: cada POST é atendido por uma instância nova; GET/DELETE não se aplicam.
      if (req.method !== "POST") {
        return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }, { allow: "POST" });
      }

      let corpo: unknown;
      try {
        corpo = await lerCorpo(req);
      } catch {
        return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "JSON inválido ou grande demais" }, id: null });
      }

      const mcp = criarServidor(ctx);
      const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transporte.close();
        void mcp.close();
      });
      await mcp.connect(transporte);
      await usuarioAtual.run(usuario, () => transporte.handleRequest(req, res, corpo));
    } catch (e) {
      console.error("[mcp-sienge] erro na requisição:", (e as Error).message);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  });

  const limpeza = setInterval(() => limparCsvsAntigos(cfg.pastaExportacao), 60 * 60 * 1000);
  limpeza.unref();
  servidor.on("close", () => clearInterval(limpeza));
  return servidor;
}
