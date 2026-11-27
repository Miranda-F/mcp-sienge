/** Agrupamentos e totais calculados no servidor, para a IA receber resumos em vez de linhas cruas. */

export type Extrator<T> = (item: T) => string | number | null | undefined;
export type Medida<T> = (item: T) => number;

export interface Grupo {
  grupo: string;
  quantidade: number;
  [medida: string]: string | number;
}

export function numero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function arredondar(n: number): number {
  return Math.round(n * 100) / 100;
}

export function somar<T>(itens: T[], medida: Medida<T>): number {
  return arredondar(itens.reduce((s, i) => s + medida(i), 0));
}

/**
 * Agrupa itens por uma chave e soma as medidas. Ordena pela primeira medida (desc)
 * e devolve no máximo `top` grupos, juntando o restante em "(outros)".
 */
export function agrupar<T>(itens: T[], chave: Extrator<T>, medidas: Record<string, Medida<T>>, top = 20): Grupo[] {
  const mapa = new Map<string, Grupo>();
  const nomes = Object.keys(medidas);
  for (const item of itens) {
    const k = String(chave(item) ?? "(não informado)");
    let g = mapa.get(k);
    if (!g) {
      g = { grupo: k, quantidade: 0 };
      for (const m of nomes) g[m] = 0;
      mapa.set(k, g);
    }
    g.quantidade++;
    for (const m of nomes) g[m] = (g[m] as number) + medidas[m]!(item);
  }
  const principal = nomes[0];
  const grupos = [...mapa.values()].sort((a, b) =>
    principal ? (b[principal] as number) - (a[principal] as number) : b.quantidade - a.quantidade,
  );
  for (const g of grupos) for (const m of nomes) g[m] = arredondar(g[m] as number);
  if (grupos.length <= top) return grupos;
  const resto = grupos.slice(top);
  const outros: Grupo = { grupo: `(outros ${resto.length})`, quantidade: resto.reduce((s, g) => s + g.quantidade, 0) };
  for (const m of nomes) outros[m] = arredondar(resto.reduce((s, g) => s + (g[m] as number), 0));
  return [...grupos.slice(0, top), outros];
}

/** "2025-03-17" -> "2025-03" */
export function mes(data: unknown): string | undefined {
  return typeof data === "string" && data.length >= 7 ? data.slice(0, 7) : undefined;
}

/** Data de hoje (AAAA-MM-DD) no fuso de Brasília. */
export function hojeBrasil(agora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}
