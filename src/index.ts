#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { carregarConfig, ErroConfiguracao } from "./config.js";
import { criarContexto, criarServidor } from "./servidor.js";

async function principal(): Promise<void> {
  let cfg;
  try {
    cfg = carregarConfig();
  } catch (e) {
    if (e instanceof ErroConfiguracao) {
      // stdout é do protocolo MCP; mensagens vão para stderr.
      console.error(`[mcp-sienge] Configuração inválida: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const servidor = criarServidor(criarContexto(cfg));
  await servidor.connect(new StdioServerTransport());
  console.error(`[mcp-sienge] pronto (subdomínio ${cfg.subdominio}, somente leitura)`);
}

principal().catch((e) => {
  console.error("[mcp-sienge] falha fatal:", e);
  process.exit(1);
});
