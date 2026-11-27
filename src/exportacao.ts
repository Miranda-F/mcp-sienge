import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Achata um objeto: {a:{b:1}} -> {"a.b":1}; arrays viram JSON. */
function achatar(obj: unknown, prefixo = "", saida: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    saida[prefixo || "valor"] = obj;
    return saida;
  }
  if (Array.isArray(obj)) {
    saida[prefixo || "valor"] = JSON.stringify(obj);
    return saida;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const chave = prefixo ? `${prefixo}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) achatar(v, chave, saida);
    else saida[chave] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return saida;
}

function celula(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Formato brasileiro para o Excel: vírgula decimal.
  let s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  // Evita que o Excel interprete o texto como fórmula.
  if (/^[=+\-@]/.test(s) && typeof v !== "number") s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Gera CSV (separador ";", UTF-8 com BOM) pronto para abrir no Excel em português. */
export function paraCsv(itens: unknown[]): string {
  const linhas = itens.map((i) => achatar(i));
  const colunas: string[] = [];
  const vistas = new Set<string>();
  for (const l of linhas) for (const k of Object.keys(l)) if (!vistas.has(k)) (vistas.add(k), colunas.push(k));
  const corpo = linhas.map((l) => colunas.map((c) => celula(l[c])).join(";"));
  return "﻿" + [colunas.join(";"), ...corpo].join("\r\n");
}

/**
 * Grava o CSV em `pasta` com nome seguro e devolve o caminho absoluto.
 * Com `aleatorio`, acrescenta 128 bits aleatórios ao nome (link de download não adivinhável).
 */
export function gravarCsv(pasta: string, nomeBase: string, itens: unknown[], agora = new Date(), aleatorio = false): string {
  const seguro = nomeBase.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "consulta";
  const carimbo = agora.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sufixo = aleatorio ? `_${randomBytes(16).toString("hex")}` : "";
  mkdirSync(pasta, { recursive: true });
  const arquivo = resolve(join(pasta, `${seguro}_${carimbo}${sufixo}.csv`));
  writeFileSync(arquivo, paraCsv(itens), "utf8");
  return arquivo;
}
