// Baixa os documentos OpenAPI oficiais do Sienge para docs/openapi/.
// Uso: node scripts/baixar-openapi.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.sienge.com.br/v1/docs/";
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const destino = join(raiz, "docs", "openapi");

async function texto(url) {
  const r = await fetch(url, { headers: { "user-agent": "mcp-sienge-docs-sync" } });
  if (!r.ok) throw new Error(`${r.status} ao baixar ${url}`);
  return r.text();
}

const indice = await texto(BASE);
const paginas = [...new Set([...indice.matchAll(/href="\.\/(html-files\/[^"?]+\.html)/g)].map((m) => m[1]))];
// Título do menu de cada página (para o catálogo de módulos).
const titulos = Object.fromEntries(
  [...indice.matchAll(/href="\.\/(html-files\/[^"?]+\.html)[^"]*"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2].trim()]),
);
// Área (seção do menu) de cada página.
const areas = {};
let areaAtual = "";
for (const linha of indice.split("\n")) {
  const sec = linha.match(/class="[^"]*menu-section[^"]*"[^>]*>([^<]+)</) ?? linha.match(/<h\d[^>]*>([^<]+)<\/h\d>/);
  if (sec) areaAtual = sec[1].replace(/[^\p{L}\p{N} /()-]/gu, "").trim();
  const pg = linha.match(/href="\.\/(html-files\/[^"?]+\.html)/);
  if (pg) areas[pg[1]] = areaAtual;
}

await mkdir(destino, { recursive: true });
const modulos = [];
for (const pagina of paginas) {
  const html = await texto(BASE + pagina);
  const m = html.match(/initResourceSwaggerUI\("\.\/\.\.\/(yaml-files\/[^"?]+\.ya?ml)/);
  if (!m) {
    console.warn(`sem YAML: ${pagina}`);
    continue;
  }
  const arquivo = m[1].split("/").pop();
  const yaml = await texto(BASE + m[1]);
  await writeFile(join(destino, arquivo), yaml, "utf8");
  modulos.push({ arquivo, titulo: titulos[pagina] ?? arquivo, area: areas[pagina] ?? "" });
  console.log(`ok ${arquivo} (${yaml.length} bytes)`);
}
await writeFile(join(destino, "_modulos.json"), JSON.stringify(modulos, null, 2), "utf8");
console.log(`${modulos.length} documentos salvos em ${destino}`);
