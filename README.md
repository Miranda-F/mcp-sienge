# mcp-sienge

Servidor MCP **somente leitura** para a API do Sienge. Ele permite que um agente de IA (Openbot, Claude Desktop, Claude Code etc.) pesquise e responda perguntas sobre os dados do ERP. Nenhuma ferramenta altera dados: o servidor só faz requisições `GET`.

## Requisitos

- Node.js 20 ou mais novo.
- Um usuário de API do Sienge criado no **Painel de Integrações**. É um usuário próprio para a API, não o login normal. Libere só os módulos que vai consultar.
- O subdomínio da empresa. Se você acessa `minhaempresa.sienge.com.br`, o subdomínio é `minhaempresa`.

## Instalação

```powershell
npm install
```

```powershell
npm run build
```

O servidor compilado fica em `dist/index.js`.

## Duas formas de rodar

| Modo | Onde roda | Como o Openbot conecta | Onde fica a senha do Sienge |
|---|---|---|---|
| **HTTP** (`dist/http.js`) | Servidor (Docker) | Streamable HTTP + token | Só no servidor |
| **stdio** (`dist/index.js`) | No computador de cada usuário | STDIO (comando local) | No Openbot de cada usuário |

## Deploy em servidor (modo HTTP, Docker)

**1. Gere um token de acesso**, que é a senha para conectar ao MCP:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**2. Configure as variáveis de ambiente.** Copie o [.env.example](.env.example) para `.env` e preencha:

```
SIENGE_SUBDOMAIN=minhaempresa
SIENGE_API_USER=usuario-api
SIENGE_API_PASSWORD=senha-da-api
MCP_AUTH_TOKENS=openbot:COLE_O_TOKEN_AQUI
MCP_PUBLIC_URL=https://sienge-mcp.seudominio.com.br
```

**3. Construa e rode o container:**

```powershell
docker build -t mcp-sienge .
```

```powershell
docker run -d --name mcp-sienge --env-file .env -p 3000:3000 -v mcp-sienge-dados:/data --restart unless-stopped mcp-sienge
```

- **Porta:** o servidor escuta na **3000**. Coloque um proxy reverso com HTTPS na frente (o domínio de `MCP_PUBLIC_URL`).
- **Volume:** o volume em **`/data`** guarda o contador de uso diário, a auditoria e os CSVs exportados.

**4. Verifique:** abra `https://sienge-mcp.seudominio.com.br/health`. A resposta deve ser `{"ok":true,...}`.

**5. No Openbot**, vá em **Apps → Conectar a um MCP personalizado** e escolha a aba **Streamable HTTP**:

- **Nome:** `Sienge`
- **URL:** `https://sienge-mcp.seudominio.com.br/mcp`
- **Header:** `Authorization` com o valor `Bearer COLE_O_TOKEN_AQUI`. Se o Openbot só aceitar um campo de chave, use o header `X-API-Key` com o token sem "Bearer".

Detalhes do modo HTTP:

- **Endpoints:**
  - `POST /mcp`: o MCP em si. É sem sessão e exige o token.
  - `GET /health`: verificação de saúde, não exige token.
  - `GET /exportacoes/<arquivo>.csv`: download dos CSVs.
- **Vários tokens:** `MCP_AUTH_TOKENS=ana:token1,joao:token2`. O nome de cada token aparece no log de auditoria. Para revogar um acesso, apague o token e reinicie o container.
- **CSV exportado:** a ferramenta devolve um **link** em vez do caminho local. O nome do arquivo tem 128 bits aleatórios e expira em 24 h.
- **Limites compartilhados:** o limite por minuto, a cota e o cache valem para todos os usuários do servidor.
- **Segurança:** quem tiver a URL e um token consegue ler os dados do ERP. Guarde o token como uma senha. Mais de 20 tentativas erradas por minuto do mesmo IP são bloqueadas.

## Uso no Openbot (modo stdio, local)

No Openbot, adicione um servidor MCP do tipo **stdio** (em Marketplace ou Settings → servidor personalizado). Preencha assim:

| Campo | Valor |
|---|---|
| Comando | `node` |
| Argumentos | `C:\Users\miran\Downloads\MCP-Sienge\dist\index.js` |
| Variável `SIENGE_SUBDOMAIN` | subdomínio da empresa |
| Variável `SIENGE_API_USER` | usuário da API |
| Variável `SIENGE_API_PASSWORD` | senha da API |

Em times do Openbot, os membros conseguem ver as variáveis de ambiente dos servidores compartilhados. Por isso, use este servidor como servidor pessoal. Não o compartilhe com a senha dentro.

## Uso no Claude Desktop / Claude Code

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sienge": {
      "command": "node",
      "args": ["C:\\Users\\miran\\Downloads\\MCP-Sienge\\dist\\index.js"],
      "env": {
        "SIENGE_SUBDOMAIN": "minhaempresa",
        "SIENGE_API_USER": "usuario-api",
        "SIENGE_API_PASSWORD": "senha"
      }
    }
  }
}
```

## Configuração (variáveis de ambiente)

| Variável | Padrão | Para que serve |
|---|---|---|
| `SIENGE_SUBDOMAIN` | obrigatória | Subdomínio do cliente Sienge |
| `SIENGE_API_USER` | obrigatória | Usuário da API (Painel de Integrações) |
| `SIENGE_API_PASSWORD` | obrigatória | Senha da API |
| `SIENGE_RATE_LIMIT_REST` | 150 | Chamadas REST por minuto (o Sienge permite 200 por subdomínio, somando todos os sistemas) |
| `SIENGE_RATE_LIMIT_BULK` | 15 | Chamadas Bulk por minuto (o Sienge permite 20) |
| `SIENGE_DAILY_QUOTA_REST` | — | Cota diária REST do seu pacote. Ao atingir, o servidor para de chamar |
| `SIENGE_DAILY_QUOTA_BULK` | — | Cota diária Bulk do seu pacote |
| `SIENGE_MAX_REGISTROS` | 1000 | Máximo de registros por consulta paginada |
| `SIENGE_MAX_CARACTERES` | 60000 | Tamanho máximo da resposta enviada à IA |
| `SIENGE_TOOL_TIMEOUT_S` | 60 | Tempo máximo de cada ferramenta (a exportação usa até 5 min) |
| `SIENGE_HTTP_TIMEOUT_S` | 30 | Tempo máximo de cada requisição HTTP |
| `SIENGE_EXPORT_DIR` | `~/sienge-exportacoes` | Pasta dos CSVs exportados |
| `SIENGE_STATE_DIR` | `~/.mcp-sienge` | Contador de uso diário e log de auditoria |
| `SIENGE_LOG` | `~/.mcp-sienge/auditoria.jsonl` | Log de auditoria (`off` desliga) |
| `SIENGE_MASCARAR_DADOS` | sim | `nao` desliga a máscara de CPF/RG e de dados bancários |
| `SIENGE_INDEXADOR_CORRECAO` | 1 | Indexador usado na correção do contas a pagar (Bulk `/outcome`) |
| `MCP_AUTH_TOKENS` | obrigatória no modo HTTP | Tokens aceitos (`nome:token`, separados por vírgula; mínimo de 32 caracteres) |
| `MCP_PUBLIC_URL` | `http://localhost:PORT` | URL pública do servidor, usada nos links de CSV |
| `PORT` | 3000 | Porta HTTP |

## Ferramentas

**Gerais**

| Ferramenta | O que faz |
|---|---|
| `sienge_status` | Testa a conexão e mostra a configuração e o uso do dia |
| `sienge_rotas` | Pesquisa as 203 consultas GET disponíveis e mostra os parâmetros de cada uma |
| `sienge_consultar` | Executa qualquer consulta GET da lista, com paginação automática |
| `sienge_bulk` / `sienge_bulk_resultado` | Bulk Data (síncrono ou assíncrono) com totais, agrupamento e amostra |
| `sienge_exportar_csv` | Grava a lista completa em CSV, que abre no Excel |

**Cadastros:** `sienge_empresas`, `sienge_obras`, `sienge_centros_custo`, `sienge_credores`, `sienge_clientes`.

**Financeiro**

| Ferramenta | O que faz |
|---|---|
| `sienge_resumo_contas_pagar` | Totais, saldo, valor pago e vencido, agrupados por credor, obra, mês etc. (via Bulk) |
| `sienge_titulos_pagar` / `sienge_titulo_pagar_detalhe` | Lista e detalhe de títulos a pagar |
| `sienge_resumo_contas_receber` | Totais do contas a receber (via Bulk) |
| `sienge_titulos_receber_cliente` | Títulos a receber de um cliente |
| `sienge_inadimplencia` | Atrasos por faixa de dias e maiores devedores |
| `sienge_saldos_bancarios` / `sienge_extrato_bancario` | Saldos e movimentações das contas |

**Suprimentos:** `sienge_pedidos_compra`, `sienge_pedido_compra_detalhe`, `sienge_solicitacoes_compra`, `sienge_contratos_suprimentos`, `sienge_estoque`.

## Segurança

- **Somente leitura.** O cliente HTTP só tem o método `GET`. Cada consulta passa por uma lista fixa de rotas gerada da documentação oficial (`src/generated/rotas.json`). Rotas e parâmetros fora da lista são recusados antes de qualquer chamada.
- **GETs desabilitados:** os que geram PDF, link de boleto de 2ª via ou download de anexo. São 15 rotas, com `bloqueado` no catálogo.
- **Bulk Data assíncrono:** só é usado consultando o andamento por GET. O webhook (`_asyncWebHookUrl`) é proibido.
- **Base URL:** só aceita `https://api.sienge.com.br` (ou localhost, nos testes).
- **Máscara de dados:** CPF e RG aparecem mascarados nas respostas, assim como agência, conta e chave PIX nas rotas de dados bancários.
- **Sem credenciais para a IA:** o usuário e a senha da API nunca são devolvidos ao modelo.
- **Auditoria:** cada chamada de ferramenta é registrada em `~/.mcp-sienge/auditoria.jsonl`.

## Grandes volumes

- **Paginação:** consultas paginadas são percorridas em páginas de 200 até `SIENGE_MAX_REGISTROS`. A resposta informa o total e o `proximo_offset`.
- **Resumos:** as ferramentas de resumo usam Bulk Data (uma chamada para o período todo) e agregam os dados no servidor.
- **Respostas grandes:** respostas acima de `SIENGE_MAX_CARACTERES` são cortadas, com aviso.
- **Lista completa:** para todos os registros, use `sienge_exportar_csv`.
- **Limites:** o servidor respeita o limite por minuto e repete a chamada após erro 429 ou 5xx (lendo `Retry-After`). Se o prazo acabar no meio, devolve o resultado parcial.

## Desenvolvimento

```powershell
npm test
```

Os testes usam um Sienge falso local e não precisam de credenciais.

```powershell
npm run dev
```

Roda o servidor direto do TypeScript.

Para atualizar o catálogo quando a Sienge mudar a API:

```powershell
npm run baixar:openapi
```

```powershell
npm run gerar:rotas
```

A referência da API está em [docs/sienge-api-referencia.md](docs/sienge-api-referencia.md) e o plano em [PLANO.md](PLANO.md).
