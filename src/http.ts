#!/usr/bin/env node
// Entrada do modo HTTP (Streamable HTTP), para rodar em servidor/Docker.
import { carregarConfig, ErroConfiguracao } from "./config.js";
import { carregarConfigHttp, criarServidorHttp } from "./servidor-http.js";

try {
  const cfg = carregarConfig();
  const http = carregarConfigHttp();
  const servidor = criarServidorHttp(cfg, http);
  servidor.listen(http.porta, "0.0.0.0", () => {
    console.error(
      `[mcp-sienge] HTTP na porta ${http.porta} (subdomínio ${cfg.subdominio}, somente leitura, ${http.tokens.size} token(s)). Endpoint: ${http.urlPublica}/mcp`,
    );
  });
  const parar = () => servidor.close(() => process.exit(0));
  process.on("SIGTERM", parar);
  process.on("SIGINT", parar);
} catch (e) {
  if (e instanceof ErroConfiguracao) {
    console.error(`[mcp-sienge] Configuração inválida: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
