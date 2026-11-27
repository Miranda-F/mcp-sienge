import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Nome do token que fez a requisição (modo HTTP), para aparecer na auditoria. */
export const usuarioAtual = new AsyncLocalStorage<string>();

export interface RegistroAuditoria {
  ferramenta: string;
  argumentos: unknown;
  resultado: "ok" | "erro";
  duracaoMs: number;
  erro?: string;
}

/** Log JSONL de cada chamada de ferramenta, gravado fora da pasta do código. */
export class Auditoria {
  constructor(private arquivo: string | null) {
    if (arquivo) {
      try {
        mkdirSync(dirname(arquivo), { recursive: true });
      } catch {
        this.arquivo = null;
      }
    }
  }

  registrar(r: RegistroAuditoria): void {
    if (!this.arquivo) return;
    const args = JSON.stringify(r.argumentos ?? {});
    const linha = {
      quando: new Date().toISOString(),
      ...(usuarioAtual.getStore() ? { usuario: usuarioAtual.getStore() } : {}),
      ...r,
      argumentos: args.length > 1000 ? args.slice(0, 1000) + "…" : JSON.parse(args),
    };
    try {
      appendFileSync(this.arquivo, JSON.stringify(linha) + "\n", "utf8");
    } catch {
      /* auditoria nunca derruba a ferramenta */
    }
  }
}
