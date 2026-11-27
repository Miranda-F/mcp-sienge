# Referência da API Sienge (leitura de https://api.sienge.com.br/v1/docs/)

Lida em 2026-11-26. Os números vêm dos arquivos OpenAPI de cada módulo.

## Regras gerais

- **URL REST:** `https://api.sienge.com.br/{subdominio}/public/api/v1/{recurso}`
- **URL Bulk Data:** `https://api.sienge.com.br/{subdominio}/public/api/bulk-data/v1/{recurso}`
- O subdomínio é o mesmo prefixo do acesso web (`minhaempresa.sienge.com.br` → `minhaempresa`). Sempre HTTPS.
- **Autenticação:** só Basic Auth (`Authorization: Basic base64(usuario-api:senha)`). As credenciais vêm do Painel de Integrações. Não há API key nem OAuth.
- **Limite por minuto (por subdomínio, somando todos os sistemas):** REST 200/min, Bulk 20/min. Ao estourar, retorna 429.
- **Cota diária por pacote:**

  | | Free | Start | Special | Essencial | Enterprise | Business | Ultimate | Infinity |
  |---|---|---|---|---|---|---|---|---|
  | REST | 100* | 1.000 | 2.500 | 5.000 | 10.000 | 30.000 | 75.000 | 200.000 |
  | BULK | 10* | 20* | 50* | 100* | 200* | 600* | 28.800* | 40.000* |

  \* bloqueia ao atingir a cota (429 até o dia seguinte).
- **Bulk Data está em todos os pacotes**, com cotas maiores no Ultimate e no Infinity. Isso corrige a documentação antiga, que dizia "só Ultimate".
- **Paginação REST:** `limit` (padrão 100, máximo 200) e `offset`. A resposta vem como `{ resultSetMetadata: { count, offset, limit }, results: [...] }`, e `count` é o total geral.
- **Erro padrão:** `{ status, developerMessage, clientMessage, errors: [{ field, message }] }`. `clientMessage` é próprio para mostrar ao usuário.
- **Status:** 200, 201, 204 / 400, 401, 403, 404, 415, 422, 429, 500, 503. Os status 401, 403 e 429 podem ocorrer em qualquer chamada, mesmo que não apareçam listados na operação.
- **Bulk síncrono:** `{ data: [...] }` em stream, sem paginação.
- **Bulk assíncrono:**
  1. Chame com `_async=true` (opcionais: `_asyncChunkMaxSize` em KB, `_asyncWebHookUrl`, `_asyncWebHookToken`). A resposta é `{ identifier }`.
  2. Consulte `GET /bulk-data/v1/async/{identifier}`. O status vai de Waiting para Processing e termina em Finished (com `chunks`) ou Failed.
  3. Baixe cada parte em `GET /bulk-data/v1/async/{identifier}/result/{1..N}`. Os resultados ficam disponíveis por 24 h.
- **Webhooks:**
  - O Sienge faz POST no endpoint cadastrado e espera a resposta por até 2,5 s.
  - Se falhar, tenta de novo depois de 10 min, 30 min, 1 h, 3 h e 5 h (cerca de 10 h no total).
  - Headers enviados: `x-sienge-tenant`, `x-sienge-event`, `x-sienge-hook-id`, `x-sienge-id` (use para idempotência) e `user-agent: sienge-hooks`.
  - Cadastro em `/hooks` (GET, POST, GET por id, DELETE).
  - Exemplos de eventos: `PAYMENT_INSTALLMENT_*`, `RECEIVABLE_INSTALLMENT_*`, `RECEIPT_PROCESSED`, `BANK_MOVEMENT_*`, `SALES_COMMISSION_*`, `ACCOUNTANCY_ACCOUNT_*`, `BUILDING_COST_ESTIMATION*` e `KEYS_HANDOVER_*`.

## Especificações OpenAPI

Cada módulo tem um YAML público em `https://api.sienge.com.br/v1/docs/yaml-files/{arquivo}`. O nome de cada arquivo está na tabela abaixo. Com esses arquivos dá para gerar tipos, validar parâmetros e montar um servidor fake para testes.

## Totais

88 módulos e **369 endpoints**:

| GET | POST | PATCH | PUT | DELETE |
|---|---|---|---|---|
| 218 | 73 | 43 | 27 | 8 |

## Módulos (leitura = GET; escrita = POST/PUT/PATCH/DELETE)

| Área | Módulo | YAML | Leitura | Escrita |
|---|---|---|---|---|
| Engenharia | Empreendimentos (Obras) | enterprise-v1.yaml | 3 | 0 |
| Engenharia | Planejamentos de Obra | building-projects-v1.yaml | 1 | 1 |
| Engenharia | Acompanhamentos de Obra | building-projects-progress-logs-v1.yaml | 3 | 1 |
| Engenharia | Locais de Obra | sites-v1.yaml | 1 | 0 |
| Engenharia | Diário de Obra | construction-daily-report-v1.yaml | 5 | 11 |
| Engenharia | Orçamentos de Obra | building-cost-estimations-v1.yaml | 2 | 0 |
| Engenharia | Insumos Orçados | building-cost-estimation-cost-estimate-resources-v1.yaml | 1 | 0 |
| Engenharia | Insumos do Orçamento da Obra | building-cost-estimation-resources-v1.yaml | 2 | 2 |
| Engenharia | Tabelas de Custos Unitários | cost-databases-v1.yaml | 5 | 0 |
| Engenharia | Unidades de movimento | resource-units-of-movement-v1.yaml | 1 | 0 |
| Engenharia | Calendários de Obra | building-calendar-v1.yaml | 2 | 3 |
| Engenharia | Grupos de Serviços | work-item-groups-v1.yaml | 1 | 0 |
| Suprimentos | Contratos de Suprimentos | contracts-v1.yaml | 9 | 3 |
| Suprimentos | Medições de Contratos | measurement-v1.yaml | 6 | 4 |
| Suprimentos | Pedidos de Compra | purchase-orders-v1.yaml | 13 | 7 |
| Suprimentos | Solicitações de Compra | purchase-requests-v1.yaml | 6 | 8 |
| Suprimentos | Cotações de Preços | purchase-quotations-v1.yaml | 2 | 8 |
| Suprimentos | Nota Fiscal de Compra | purchase-invoices-v1.yaml | 5 | 2 |
| Suprimentos | Estoque de Insumos | stock-inventories-v1.yaml | 6 | 3 |
| Suprimentos | Categorias de Suprimentos | supply-categories.yaml | 2 | 0 |
| Financeiro | Contas-Correntes | checking-accounts-v1.yaml | 1 | 0 |
| Financeiro | Centro de Custos | cost-center-v1.yaml | 4 | 0 |
| Financeiro | Credores | creditor-v1.yaml | 4 | 13 |
| Financeiro | Departamentos | departments-v1.yaml | 2 | 0 |
| Financeiro | Documentos | document-identification-v1.yaml | 2 | 0 |
| Financeiro | Planos Financeiros | payment-categories-v1.yaml | 2 | 0 |
| Financeiro | Relatório de Extrato de Credores (PDF) | creditor-report-v1.yaml | 1 | 0 |
| Financeiro | Títulos do Contas a Receber | accounts-receivable-v1.yaml | 4 | 1 |
| Financeiro | Títulos do Contas a Pagar | bill-debt-v1.yaml | 22 | 21 |
| Financeiro | Portadores (Receber) | bearers-receivable-v1.yaml | 1 | 0 |
| Financeiro | Saldo Devedor Presente (geração/PDF) | current-debit-balance-v1.yaml | 2 | 0 |
| Financeiro | Extrato de Cliente (e-mail/PDF) | customer-financial-statements-v1.yaml | 2 | 1 |
| Financeiro | Informe de Rendimentos IR | customer-income-tax-v1.yaml | 1 | 1 |
| Financeiro | Saldo Devedor Presente (e-mail) | email-current-debit-balance-v1.yaml | 0 | 1 |
| Financeiro | Indexadores | indexers-v1.yaml | 1 | 0 |
| Financeiro | Reparcelamentos | remade-installments-v1.yaml | 1 | 2 |
| Financeiro | Saldo Devedor Presente (Total) | total-current-debit-balance-v1.yaml | 1 | 0 |
| Financeiro | Cobrança de Parcelas Vencidas | overdue-receivable-v1.yaml | 0 | 1 |
| Financeiro | Boleto 2ª via | payment-slip-notification-v1.yaml | 1 | 1 |
| Financeiro | Antecipação de Parcelas | prepayment-slip-register-v1.yaml | 0 | 3 |
| Financeiro | Histórico de Notificação de Cobranças | collections-notification-history-v1.yaml | 1 | 0 |
| Notas Fiscais | NF-e de Produto | nfe-api-v1.yaml | 15 | 0 |
| Notas Fiscais | Info. Fiscais de Serviço (Pagar) | tax-information-v1.yaml | 0 | 2 |
| Notas Fiscais | Pré-Cadastro de NFS | service-invoice-pre-registration.yaml | 0 | 1 |
| Contabilidade | Contas Contábeis | accountancy-accounts-v1.yaml | 2 | 0 |
| Contabilidade | Lotes Contábeis | accountancy-batch-v1.yaml | 1 | 1 |
| Contabilidade | Fechamento Contábil | accountancy-closingaccountancy-v1.yaml | 1 | 0 |
| Contabilidade | Lançamentos Contábeis | accountancy-entries-v1.yaml | 2 | 2 |
| Contabilidade | Lançamentos (Integração Contábil) | accountancy-entrygenerator-entrybatches-v1.yaml | 5 | 0 |
| Contabilidade | Saldo de Contas Correntes | accounts-balances-v1.yaml | 1 | 0 |
| Contabilidade | Extrato de Contas | accounts-statements-v1.yaml | 1 | 0 |
| Contabilidade | Balancete de Verificação | trial-balance-v1.yaml | 1 | 0 |
| Comercial | Tipos de Clientes | customer-types-v1.yaml | 1 | 0 |
| Comercial | Comissões | commissions-v1.yaml | 5 | 13 |
| Comercial | Comissões (Antigo) | commissions-forecasts-v1.yaml | 1 | 1 |
| Comercial | Contratos de Vendas | sales-contracts-v1.yaml | 6 | 8 |
| Comercial | Unidades de Imóveis | unit-v1.yaml | 6 | 10 |
| Comercial | Reservas de Unidades | unit-bookings-v1.yaml | 0 | 2 |
| Comercial | Tabela de Preços | price-tables-v1.yaml | 1 | 0 |
| Comercial | Profissões | professions-v1.yaml | 2 | 1 |
| Comercial | Locação de Imóveis | property-rental-v1.yaml | 1 | 1 |
| Comercial | Tipo de Imóveis | property-types-v1.yaml | 2 | 0 |
| Comercial | Estados Civis | civil-status-v1.yaml | 1 | 1 |
| Comercial | Tipos de Condição de Pagamento | payment-condition-types-v1.yaml | 1 | 0 |
| Ativos | Bens Imóveis | fixed-assets-v1.yaml | 1 | 0 |
| Ativos | Bens Móveis | movable-assets-v1.yaml | 1 | 0 |
| Ativos | Mapa Imobiliário Consolidado | real-estate-map-v1.yaml | 1 | 0 |
| Segurança | Parâmetros | parameters-v1.yaml | 1 | 0 |
| Apoio | Marcas | trademarks-v1.yaml | 1 | 0 |
| Apoio | Unidades de Medidas | units-of-measure-v1.yaml | 1 | 0 |
| Apoio | Clientes | customers-v1.yaml | 4 | 8 |
| Apoio | Empresas | company-v1.yaml | 2 | 0 |
| Apoio | Municípios | cities-v1.yaml | 1 | 0 |
| Webhooks | Gerenciamento de Webhooks | hooks-v1.yaml | 2 | 2 |

### Bulk Data (somente leitura, `bulk-data/v1`)

| Recurso | Caminho(s) |
|---|---|
| Orçamento empresarial | `/business-budget` |
| Caixas e Bancos | `/bank-movement`, `/bank-movement/by-movements` |
| Contratos de Vendas | `/sales` |
| Cotações de preços | `/purchase-quotations` |
| Extrato Cliente Histórico | `/customer-extract-history` |
| Insumos da Obra | `/building/resources` |
| Itens de Orçamento | `/building-cost-estimation-items` |
| Parcelas a Pagar | `/outcome`, `/outcome/by-bills` |
| Parcelas a Receber | `/income`, `/income/by-bills` |
| Relatório de Notas Fiscais | `/invoice-itens` |
| Saldo Devedor Cliente | `/customer-debt-balance` |
| Saldos Contábeis por Centro de Custo | `/accountancy/accountCostCenterBalance` |
| Saldos Contábeis por Empresa | `/accountancy/accountBalance` |
| Títulos Inadimplentes | `/defaulters-receivable-bills`, `/defaulters-receivable-bills/by-aging` |

## Endpoints principais por processo (candidatos a ferramentas do MCP)

- **Obras:** `GET /enterprises`, `GET /enterprises/{id}`, `GET /building-cost-estimations/{buildingId}/sheets` e `.../items`, `GET /building-projects/progress-logs`, `GET /construction-daily-report`
- **Compras:**
  - Solicitações: `GET /purchase-requests/{id}`, `GET /purchase-requests/all/items`
  - Pedidos: `GET /purchase-orders`, `GET /purchase-orders/{id}`, `.../items`, `.../totalization`
  - Notas fiscais de compra: `GET /purchase-invoices`
  - Cotações: `GET /purchase-quotations/all/negotiations`
- **Contratos de suprimentos:** `GET /supply-contracts/all`, `GET /supply-contracts/items`, `GET /supply-contracts/measurements/all`
- **Estoque:** `GET /stock-inventories/{costCenterId}/items`, `GET /inventory-movements`
- **Contas a pagar:** `GET /bills`, `GET /bills/by-change-date`, `GET /bills/{id}`, `.../installments`, `.../budget-categories`, `.../buildings-cost`
- **Contas a receber:** `GET /accounts-receivable/receivable-bills`, `.../{id}/installments`, `GET /current-debit-balance`, `GET /customer-financial-statements`
- **Caixa e bancos:** `GET /checking-accounts`, `GET /accounts-balances`, `GET /accounts-statements`
- **Cadastros:** `GET /creditors`, `GET /customers`, `GET /companies`, `GET /cost-centers`, `GET /payment-categories`, `GET /departments`
- **Comercial:** `GET /sales-contracts`, `GET /units`, `GET /price-tables`, `GET /real-estate-map`, `GET /commissions`
- **Contabilidade:** `GET /accountancy/accounts`, `GET /accountancy/entries`, `GET /trial-balance`, `GET /closingaccountancy`
- **NF-e:** `GET /nfes`, `GET /nfes/{nfeKey}` e sub-recursos

> **Versão 1 do MCP: somente leitura.** Só os GETs entram. Também ficam de fora os GETs que geram PDF ou link de boleto (`/payment-slip-notification` e `.../pdf`) e os downloads de anexos. A lista abaixo serve só como referência para o futuro.

### Escritas de maior risco (fora da v1)

- **Aprovações:**
  - `PATCH /purchase-requests/{id}/authorize` e `/disapproval`
  - `PUT` e `PATCH /purchase-orders/{id}/authorize` e `/disapprove`
  - `PATCH /supply-contracts/authorize` e `/disapprove`
  - `PATCH /supply-contracts/measurements/authorize` e `/disapprove`
  - `PATCH /purchase-quotations/.../negotiations/latest/authorize`
- **Contas a pagar:** `POST /bills`, `PATCH /bills/{id}`, alterações de parcelas e de dados de pagamento (PIX, boleto, transferência)
- **Dados bancários de credores:** `POST` e `PATCH /creditors/{id}/bank-informations` e `/pix-informations`
- **Exclusões:**
  - `DELETE /sales-contracts/{id}`
  - `POST /sales-contracts/{id}/cancellation`
  - `DELETE /commissions/{id}`
  - `DELETE /remade-installments`
  - `DELETE /construction-daily-report/...`
  - `DELETE /hooks/{id}`
- **Ações que enviam algo a clientes:** `POST /payment-slip-notification`, `POST /customer-financial-statements`, `POST /email-current-debit-balance`, `POST /customer-income-tax/report`, `POST /overdue-receivable-bill`, `POST /prepayment-slip-register`

## Observações

- `/products`, que o Conectorsienge usa, **não aparece** na documentação pública atual.
- Alguns endpoints de "consulta" geram PDF ou um link temporário: `/purchase-orders/{id}/analysis/pdf`, `/creditor-report/pdf`, `/current-debit-balance/pdf` (o link expira em 5 min) e `/purchase-quotations/comparison-map/pdf`.
- Os contratos de suprimentos e as medições usam parâmetros de query em vez de id no caminho (por exemplo, `GET /supply-contracts?...`). Confira no YAML antes de implementar.
