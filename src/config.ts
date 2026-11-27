import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  subdominio: string;
  usuario: string;
  senha: string;
  baseUrl: string;
  limitePorMinutoRest: number;
  limitePorMinutoBulk: number;
  cotaDiariaRest?: number;
  cotaDiariaBulk?: number;
  maxRegistros: number;
  maxCaracteresResposta: number;
  timeoutFerramentaMs: number;
  timeoutHttpMs: number;
  pastaExportacao: string;
  pastaEstado: string;
  arquivoAuditoria: string | null;
  mascararDadosPessoais: boolean;
  indexadorCorrecao: number;
}

export class ErroConfiguracao extends Error {}

function inteiro(nome: string, padrao: number, env: NodeJS.ProcessEnv): number {
  const bruto = env[nome];
  if (bruto === undefined || bruto === "") return padrao;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) throw new ErroConfiguracao(`${nome} deve ser um número positivo (recebido: "${bruto}")`);
  return Math.floor(n);
}

function opcional(nome: string, env: NodeJS.ProcessEnv): number | undefined {
  return env[nome] ? inteiro(nome, 0, env) : undefined;
}

/** Hosts aceitos em SIENGE_BASE_URL: a API oficial e, para testes, a máquina local. */
function validarBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErroConfiguracao(`SIENGE_BASE_URL inválida: ${url}`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!local && (u.protocol !== "https:" || u.hostname !== "api.sienge.com.br")) {
    throw new ErroConfiguracao("SIENGE_BASE_URL só pode apontar para https://api.sienge.com.br (ou localhost em testes)");
  }
  return u.origin;
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const subdominio = (env.SIENGE_SUBDOMAIN ?? "").trim();
  const usuario = (env.SIENGE_API_USER ?? env.SIENGE_USERNAME ?? "").trim();
  const senha = env.SIENGE_API_PASSWORD ?? env.SIENGE_PASSWORD ?? "";
  const faltando = [
    !subdominio && "SIENGE_SUBDOMAIN",
    !usuario && "SIENGE_API_USER",
    !senha && "SIENGE_API_PASSWORD",
  ].filter(Boolean);
  if (faltando.length) throw new ErroConfiguracao(`Variáveis de ambiente ausentes: ${faltando.join(", ")}`);
  if (!/^[a-z0-9-]+$/i.test(subdominio)) throw new ErroConfiguracao("SIENGE_SUBDOMAIN deve conter só letras, números e hífen");

  const pastaEstado = env.SIENGE_STATE_DIR || join(homedir(), ".mcp-sienge");
  const log = env.SIENGE_LOG;
  return {
    subdominio,
    usuario,
    senha,
    baseUrl: validarBaseUrl(env.SIENGE_BASE_URL || "https://api.sienge.com.br"),
    limitePorMinutoRest: Math.min(inteiro("SIENGE_RATE_LIMIT_REST", 150, env), 200),
    limitePorMinutoBulk: Math.min(inteiro("SIENGE_RATE_LIMIT_BULK", 15, env), 20),
    cotaDiariaRest: opcional("SIENGE_DAILY_QUOTA_REST", env),
    cotaDiariaBulk: opcional("SIENGE_DAILY_QUOTA_BULK", env),
    maxRegistros: inteiro("SIENGE_MAX_REGISTROS", 1000, env),
    maxCaracteresResposta: inteiro("SIENGE_MAX_CARACTERES", 60000, env),
    timeoutFerramentaMs: inteiro("SIENGE_TOOL_TIMEOUT_S", 60, env) * 1000,
    timeoutHttpMs: inteiro("SIENGE_HTTP_TIMEOUT_S", 30, env) * 1000,
    pastaExportacao: env.SIENGE_EXPORT_DIR || join(homedir(), "sienge-exportacoes"),
    pastaEstado,
    arquivoAuditoria: log === "off" ? null : log || join(pastaEstado, "auditoria.jsonl"),
    mascararDadosPessoais: env.SIENGE_MASCARAR_DADOS !== "nao",
    indexadorCorrecao: inteiro("SIENGE_INDEXADOR_CORRECAO", 1, env),
  };
}
