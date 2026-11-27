// Garante que src/generated/rotas.json existe antes do build/testes.
// A documentação OpenAPI da Sienge não é versionada neste repositório (direitos do autor):
// ela é baixada do site oficial e o catálogo de rotas é gerado localmente.
// Use --forcar para baixar e gerar de novo.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const forcar = process.argv.includes("--forcar");
const rodar = (script) => execFileSync(process.execPath, [join(raiz, "scripts", script)], { stdio: "inherit" });

if (forcar || !existsSync(join(raiz, "docs", "openapi", "_modulos.json"))) rodar("baixar-openapi.mjs");
if (forcar || !existsSync(join(raiz, "src", "generated", "rotas.json"))) rodar("gerar-rotas.mjs");
