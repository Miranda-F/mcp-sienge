// Gera src/generated/rotas.json a partir dos documentos OpenAPI em docs/openapi/.
// Só operações GET entram. Algumas GET com efeito colateral ou retorno binário
// são marcadas como bloqueadas (ver BLOQUEIOS).
// Uso: node scripts/gerar-rotas.mjs
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const pastaOpenapi = join(raiz, "docs", "openapi");
const saida = join(raiz, "src", "generated", "rotas.json");

/** Regras de bloqueio aplicadas a GETs (caminho completo, base incluída). */
const BLOQUEIOS = [
  { teste: (c) => /\/pdf$/.test(c), motivo: "gera PDF ou link temporário" },
  { teste: (c) => c === "/payment-slip-notification", motivo: "gera link de boleto de 2ª via" },
  { teste: (c) => /\/attachments\/\{[^}]+\}$/.test(c), motivo: "download de anexo (binário)" },
  { teste: (c) => c === "/supply-contracts/attachments", motivo: "download de anexo (binário)" },
  { teste: (c) => c === "/supply-contracts/measurements/attachments", motivo: "download de anexo (binário)" },
];

/** Parâmetros que nunca podem ser enviados (webhook do bulk assíncrono). */
const PARAMS_PROIBIDOS = new Set(["_asyncWebHookUrl", "_asyncWebHookToken"]);

function resolver(doc, obj, profundidade = 0) {
  if (!obj || typeof obj !== "object" || profundidade > 20) return obj;
  if (obj.$ref) {
    const partes = obj.$ref.replace(/^#\//, "").split("/");
    let alvo = doc;
    for (const p of partes) alvo = alvo?.[p.replace(/~1/g, "/").replace(/~0/g, "~")];
    return resolver(doc, alvo, profundidade + 1);
  }
  return obj;
}

function encurtar(texto, max = 300) {
  if (!texto) return undefined;
  const limpo = String(texto).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return limpo.length > max ? limpo.slice(0, max - 1) + "…" : limpo;
}

function tipoDe(doc, schema) {
  const s = resolver(doc, schema) ?? {};
  if (s.type === "array") return `array<${tipoDe(doc, s.items)}>`;
  return s.format ? `${s.type ?? "string"}(${s.format})` : (s.type ?? "string");
}

/** Lista nomes de campos de primeiro nível do objeto de resultado (para orientar a IA). */
function camposResposta(doc, op) {
  const ok = resolver(doc, op.responses?.["200"] ?? op.responses?.["201"]);
  let schema = resolver(doc, ok?.content?.["application/json"]?.schema);
  if (!schema) return undefined;
  if (schema.allOf) schema = Object.assign({}, ...schema.allOf.map((s) => resolver(doc, s)));
  const props = schema.properties ?? {};
  let alvo = schema;
  for (const chave of ["results", "data"]) {
    if (props[chave]) {
      let arr = resolver(doc, props[chave]);
      if (arr?.allOf) arr = arr.allOf.map((s) => resolver(doc, s)).find((s) => s?.type === "array" || s?.items) ?? arr;
      alvo = resolver(doc, arr?.items) ?? arr;
      break;
    }
  }
  if (alvo?.type === "array") alvo = resolver(doc, alvo.items);
  if (alvo?.allOf) alvo = Object.assign({}, ...alvo.allOf.map((s) => resolver(doc, s)));
  const nomes = Object.keys(alvo?.properties ?? {});
  return nomes.length ? nomes.slice(0, 60) : undefined;
}

const modulos = JSON.parse(await readFile(join(pastaOpenapi, "_modulos.json"), "utf8"));
const porArquivo = Object.fromEntries(modulos.map((m) => [m.arquivo, m]));
const arquivos = (await readdir(pastaOpenapi)).filter((a) => /\.ya?ml$/.test(a)).sort();

const rotas = [];
for (const arquivo of arquivos) {
  const doc = parse(await readFile(join(pastaOpenapi, arquivo), "utf8"));
  const servidor = doc.servers?.[0]?.url ?? "";
  const base = servidor.includes("bulk-data") ? "bulk" : "v1";
  const meta = porArquivo[arquivo] ?? { titulo: doc.info?.title ?? arquivo, area: "" };
  for (const [caminho, item] of Object.entries(doc.paths ?? {})) {
    const op = item.get;
    if (!op) continue;
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
      .map((p) => resolver(doc, p))
      .filter((p) => p && (p.in === "query" || p.in === "path"))
      .filter((p) => !PARAMS_PROIBIDOS.has(p.name))
      .map((p) => {
        const s = resolver(doc, p.schema) ?? {};
        return {
          nome: p.name,
          em: p.in,
          obrigatorio: Boolean(p.required || p.in === "path"),
          tipo: tipoDe(doc, p.schema),
          ...(s.enum ? { valores: s.enum } : {}),
          ...(p.description ? { descricao: encurtar(p.description, 200) } : {}),
        };
      });
    const bloqueio = BLOQUEIOS.find((b) => b.teste(caminho));
    const paginado = params.some((p) => p.nome === "limit") && params.some((p) => p.nome === "offset");
    rotas.push({
      id: `${base}:${caminho}`,
      base,
      caminho,
      modulo: meta.titulo,
      area: meta.area,
      arquivo,
      resumo: encurtar(op.summary, 160) ?? "",
      ...(op.description ? { descricao: encurtar(op.description) } : {}),
      paginado,
      parametros: params,
      ...(camposResposta(doc, op) ? { campos: camposResposta(doc, op) } : {}),
      ...(bloqueio ? { bloqueado: bloqueio.motivo } : {}),
    });
  }
}

await mkdir(dirname(saida), { recursive: true });
await writeFile(saida, JSON.stringify(rotas, null, 1), "utf8");
const ativas = rotas.filter((r) => !r.bloqueado);
console.log(`${rotas.length} rotas GET (${ativas.length} liberadas, ${rotas.length - ativas.length} bloqueadas) -> ${saida}`);
