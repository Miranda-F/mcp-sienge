# Plano de criação — MCP Sienge

## 1. O que aprendemos com os projetos existentes

| | frlorenzon/MCP-Sienge-Node | rsscavalcanti-cmyk/Conectorsienge |
|---|---|---|
| Stack | Node 20, JS ESM, SDK oficial `@modelcontextprotocol/sdk` + zod | Node 18, JS puro, **sem dependências** (JSON-RPC feito à mão) |
| Transporte | stdio | stdio |
| Auth Sienge | Basic (`SIENGE_USERNAME`/`SIENGE_PASSWORD`) ou Bearer (`SIENGE_API_KEY`, não documentado pela Sienge) | Basic (`SIENGE_API_USER`/`SIENGE_API_PASSWORD`) |
| Escopo | Compras, contratos (aprovação, NF, anexos); financeiro vazio | Solicitações de compra, cotações, produtos, credores, empreendimentos + ferramenta genérica `sienge_api` e `sienge_bulk_data` |
| Escrita | Prévia + `confirmar: true` | Modos `leitura` / `assistido` / `execucao` |
| Pontos fortes | Arquitetura em camadas (api / client / modules), carregamento de módulos sob demanda, spec OpenAPI no repo, 137 testes offline | Leitura por padrão com bloqueio no servidor, log de auditoria, dicas de erro (401/403/429) |
| Pontos fracos | Sem timeout/retry/429, sem auditoria, expõe o usuário da API ao modelo, alfa | Confirmação é digitada pelo próprio modelo, `sienge_api` sem restrição, sem paginação, limite fixo de 200 itens, data em UTC |
| Licença | **PolyForm Noncommercial** — não pode ser usado comercialmente sem autorização | **MIT** — pode reaproveitar |

**Conclusão:** construir um servidor próprio, juntando a arquitetura do primeiro com as travas de segurança do segundo, e corrigindo o que falta nos dois (resiliência, paginação, confirmação humana de verdade, proteção de dados).

## 2. Cliente alvo: Openbot (openbot.run)

O Openbot (Synthetify Labs / nightly-labs) é um app desktop local que roda agentes sobre CLIs como Claude Code, Codex, Gemini, OpenCode etc. Pela documentação do repositório (`docs/architecture/integrations.md` e `providers.md`):

- Aceita **servidores MCP próprios** de dois tipos: **`stdio`** (`command` + `args`, segredos em `env`) e **`http`** (`url`, segredos em `header` ou login OAuth feito pelo próprio Openbot).
- Servidores `stdio` são iniciados pelo Openbot e repassados aos agentes por um proxy Streamable HTTP local.
- Até 100 servidores MCP por computador; cada servidor pode ser liberado para todos os agentes, para alguns ou para nenhum.
- **Atenção:** os agentes rodam com `danger-full-access` e `approvalPolicy: never`, e a configuração de acesso não limita servidores MCP. Ou seja, **não dá para contar com o Openbot pedindo aprovação antes de uma escrita** — a trava precisa estar dentro do nosso servidor.
- **Atenção (times):** membros de um time no Openbot conseguem ver os valores de `env` e `header` dos servidores compartilhados. Se a senha do Sienge ficar no `env` de um servidor compartilhado, todos os membros a verão.
- O formulário exato de "adicionar servidor" não está documentado; confirmar na tela do app (Marketplace / Settings).

**Consequências para o projeto:**
- Fase 1: servidor **stdio** (`npx mcp-sienge` ou `node dist/index.js`), credenciais em `env` — encaixa direto no tipo `stdio` + `key` do Openbot.
- Fase 2 (uso em time): servidor **HTTP (Streamable HTTP)** hospedado, com a senha do Sienge só no servidor e acesso por OAuth ou token por usuário no `header`.
- **Versão 1 é somente leitura:** o servidor só faz requisições `GET`. Como o Openbot não pede aprovação antes de chamar ferramentas, essa trava fica no código do servidor.

## 3. Autenticação: API key ou OAuth?

**A API do Sienge só aceita Basic Auth** (usuário de API + senha criados no Painel de Integrações). A documentação não fala de API key, Bearer ou OAuth. Então, do lado do Sienge, não há escolha.

A pergunta "OAuth?" só faz sentido do lado do **MCP**:

- **MCP local (stdio)** — roda na máquina do usuário; as credenciais ficam em variáveis de ambiente. Não precisa de OAuth. **Recomendado para começar.**
- **MCP remoto (HTTP)** — um servidor hospedado que vários usuários usam pelo claude.ai/Claude Desktop como conector. Aí o MCP **deve** usar OAuth 2.1 (como manda a especificação do MCP) para saber quem está chamando, e a senha do Sienge fica guardada só no servidor. Faz sentido numa fase 2, se a equipe toda for usar.

## 4. Arquitetura proposta

- **TypeScript + `@modelcontextprotocol/sdk` + zod**, Node 20+.
- Transporte **stdio** (fase 1); **Streamable HTTP + OAuth** opcional (fase 2).
- Camadas:
  - `src/config.ts` — lê e valida env (`SIENGE_SUBDOMAIN`, `SIENGE_API_USER`, `SIENGE_API_PASSWORD`, `SIENGE_MODE`, `SIENGE_LOG`).
  - `src/http/client.ts` — Basic Auth, timeout, retry com backoff para 429/5xx, limitador de 200 req/min, paginação automática (`limit`/`offset`) com teto, erros normalizados (`developerMessage`, `clientMessage`, `errors[]`).
  - `src/api/*.ts` — um arquivo por recurso do Sienge, tipado.
  - `src/tools/*.ts` — ferramentas MCP por domínio (engenharia, suprimentos, financeiro, comercial, contabilidade, apoio).
  - `src/audit.ts` — log JSONL de toda chamada, fora da pasta do código, com CPF/CNPJ mascarados.

## 5. Segurança — versão 1 somente leitura

**Decisão:** a primeira versão só lê dados. Ela permite apenas pesquisar e responder. Nada de `POST`, `PUT`, `PATCH` ou `DELETE`.

- O cliente HTTP só tem um método `get()`. Não existe código capaz de enviar outro método HTTP.
- Uma lista fixa de rotas GET permitidas, gerada a partir dos YAML oficiais. Qualquer outro caminho é recusado antes de sair do servidor.
- A consulta genérica (`sienge_consultar`) aceita só caminhos dessa lista, sem `..`, sem host externo e sem parâmetros de controle como `_asyncWebHookUrl`.
- Todas as ferramentas levam a anotação MCP `readOnlyHint: true`.
- **GETs com efeito colateral ficam de fora da v1**, mesmo sendo GET:
  - `GET /payment-slip-notification`: gera um link de boleto de 2ª via.
  - Endpoints `.../pdf` que geram relatório ou link temporário: `/current-debit-balance/pdf`, `/customer-financial-statements/pdf`, `/customer-income-tax/report/pdf`, `/creditor-report/pdf`, `/purchase-orders/{id}/analysis/pdf` e `/purchase-quotations/comparison-map/pdf`.
  - Downloads de anexos (`.../attachments/{id}`): retornam arquivos binários, que um MCP só de texto não aproveita.
- O Bulk Data entra nos modos síncrono e assíncrono. No assíncrono, o servidor consulta o status e baixa as partes por GET. Só o parâmetro `_asyncWebHookUrl` (e `_asyncWebHookToken`) fica proibido.
- Nunca devolver usuário ou senha ao modelo.
- Mascarar CPF, CNPJ e dados bancários nas respostas quando não forem necessários (LGPD). Isso vale em especial para credores (`/bank-informations` e `/pix-informations`) e clientes.
- Log de auditoria de toda chamada, gravado fora da pasta do código.
- Ferramenta genérica `sienge_api` só para GET; escrita genérica fica desligada.
- Nunca devolver usuário/senha ao modelo; validar caminhos (sem `..`, sem host externo).
- Mascarar CPF/CNPJ/dados pessoais nas respostas quando não forem necessários (LGPD).
- Testar escrita só em ambiente de homologação primeiro.

## 6. Consultas com grande volume de dados

**Regra geral:** o servidor faz o trabalho pesado (paginar, somar, agrupar) e a IA recebe só o resultado.

**Limites a respeitar:**
- **Página REST:** no máximo 200 registros.
- **Por minuto:** 200 chamadas REST e 20 Bulk, compartilhadas por todo o subdomínio.
- **Cota diária do pacote:** por exemplo, 5.000 REST/dia no Essencial.
- **Contexto da IA:** limitado.
- **Tempo:** o Openbot espera um tempo limitado pela resposta de cada ferramenta.

1. **Filtros obrigatórios ou com padrão:** período, obra ou empresa. Sem período informado, usar os últimos 30 dias e dizer isso na resposta.
2. **Contar antes de buscar:** a primeira chamada usa `limit=1` e lê `resultSetMetadata.count`.
   - Até `MAX_REGISTROS` (padrão 1.000, ou seja, 5 páginas): paginar normalmente.
   - Acima disso: usar o endpoint de Bulk Data equivalente, se existir, ou devolver um aviso pedindo para refinar a consulta, com o total encontrado.
3. **Resumo no servidor:** ferramentas de análise devolvem totais, agrupamentos (por obra, credor, mês ou situação) e os top N, não linhas cruas.
4. **Projeção de campos:** cada ferramenta devolve só os campos relevantes da resposta.
5. **Listas paginadas para a IA:** devolver no máximo 50 itens, mais o total e um `cursor` (offset) para a IA pedir a próxima parte se precisar.
6. **Bulk Data:**
   - **Síncrono** para volumes médios: uma chamada traz tudo, sem paginação.
   - **Assíncrono** (`_async=true`, consultando o status por GET e baixando as partes por GET) para volumes muito grandes. É somente leitura. Só o parâmetro `_asyncWebHookUrl` fica proibido.
   - Mapeamento REST → Bulk: `/bills` → `/outcome`; `/accounts-receivable/receivable-bills` → `/income`; `/accounts-statements` → `/bank-movement`; inadimplência → `/defaulters-receivable-bills`; itens de orçamento → `/building-cost-estimation-items`; contratos de venda → `/sales`.
7. **Exportação para arquivo:** quando o usuário pedir os dados completos, gravar CSV em `SIENGE_EXPORT_DIR` (no computador local) e devolver o caminho e um resumo. Nada é gravado no Sienge.
8. **Proteção de cota:**
   - Cache com tempo de expiração: horas para cadastros (empresas, obras, centros de custo, planos financeiros) e minutos para consultas repetidas.
   - Limitador próprio em `SIENGE_RATE_LIMIT_MIN` (padrão 150/min REST e 15/min Bulk), deixando margem para outros sistemas.
   - Contador diário com `SIENGE_DAILY_QUOTA`: avisar antes de uma consulta que custaria mais de X% da cota restante.
   - Ao receber 429: esperar (respeitando `Retry-After`, se vier) e tentar de novo com backoff.
9. **Limite de tempo:** cada ferramenta tem um tempo máximo (`SIENGE_TOOL_TIMEOUT_S`, padrão 60 s). Ao estourar, devolve o resultado parcial marcado como `parcial: true` e sugere usar Bulk Data ou um filtro mais restrito. Quando o cliente suportar, enviar notificações de progresso MCP.

## 7. Fases

**Fase 0 — Pré-requisitos**
- Criar usuário de API no Painel de Integrações, com permissão só para os módulos necessários.
- Confirmar o plano contratado (cota diária REST/Bulk) e se há ambiente de homologação.
- Definir quais processos o MCP precisa cobrir primeiro.

**Fase 1 — Base + leitura (MVP)**
- Esqueleto do projeto, cliente HTTP, `testar_conexao`.
- Ferramentas de leitura prioritárias, por exemplo: obras/empreendimentos, credores, clientes, títulos a pagar e a receber, pedidos e solicitações de compra, contratos de suprimentos.
- Ferramenta genérica `sienge_consultar` (GET apenas nas rotas da lista permitida) para cobrir o resto.
- Gerar tipos e validação a partir dos YAML OpenAPI oficiais (`https://api.sienge.com.br/v1/docs/yaml-files/*.yaml`, 88 módulos, 369 endpoints — ver [docs/sienge-api-referencia.md](docs/sienge-api-referencia.md)).
- Testes com servidor fake (mock) montado a partir dos mesmos YAML — sem credenciais reais.

**Fase 2 — Mais leitura e respostas melhores**
- Cobrir os demais GETs (218 ao todo, menos os excluídos acima).
- Ferramentas que juntam dados de vários endpoints para responder perguntas comuns, por exemplo "quanto falta pagar da obra X este mês" ou "situação do pedido Y".
- Cache de cadastros que mudam pouco (empresas, obras, centros de custo, planos financeiros) para poupar cota.

**Escrita: fora do escopo.** Fica para uma versão futura, se e quando for decidido, com confirmação em duas etapas feita pelo servidor.

**Fase 3 — Bulk Data e relatórios** (disponível em todos os pacotes; cota diária baixa fora do Ultimate/Infinity)
- Extrações assíncronas (`_async=true` → acompanhar status → baixar partes).
- Ferramentas de resumo (inadimplência, saldo devedor, extrato de caixa/bancos).

**Modo HTTP (feito em 2026-11-27):** `dist/http.js` + `Dockerfile` para rodar em servidor. Streamable HTTP sem sessão, autenticação por token (`MCP_AUTH_TOKENS`, header `Authorization: Bearer` ou `X-API-Key`), senha do Sienge só no servidor e CSV entregue por link com validade de 24 h. OAuth fica para depois, se for preciso identificar cada usuário pelo login.

**Fase 4 — Distribuição**
- Publicar como pacote npm (`npx mcp-sienge`), com instruções para Openbot (servidor `stdio`: comando `npx`, args `["-y","mcp-sienge"]`, variáveis `SIENGE_*` em `env`), Claude Desktop e Claude Code.
- Opcional: versão remota com Streamable HTTP + OAuth para o time no Openbot, sem expor a senha do Sienge.

## 8. Decisões em aberto

- Quais módulos/processos entram no MVP?
- Uso individual (stdio) ou para a equipe (remoto com OAuth)?
