// Copia src/generated/*.json para dist/generated/ depois do tsc.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(raiz, "src", "generated"), join(raiz, "dist", "generated"), { recursive: true });
