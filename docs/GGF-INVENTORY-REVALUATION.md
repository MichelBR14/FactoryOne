# GGF: previa de Reavaliacao de Estoque

## Escopo e seguranca

Implementado em 28/09/2026. Esta camada consome o resultado do motor aprovado; nao modifica o rateio nem executa contabilizacao. O objeto retornado sempre possui `postingBlocked: true`. Nao existe metodo de envio nesta camada. O gateway aceita somente GET/HEAD; o cliente SAP admite GET de negocio e POST apenas para Login/Logout.

Fluxo: apuracao -> rateio por conta/OP -> producao recebida -> proposta de custo unitario -> analise do estoque atual -> previa do documento, ou bloqueios explicitos.

Dois modos separados:

- Desenvolvimento demonstrativo: resultado da simulacao local, estoque e evidencias deliberadamente ficticios, identificados por `origin: development`, empresa `DEVELOPMENT`, deposito/documentos/contas `DEV-*`.
- SAP real: apuracao aprovada explicitamente informada ao processo local; releitura das OPs, recebimentos, politica de avaliacao, itens e saldos em SBODEMOBR2. Nenhum fallback demonstrativo. A conta da validacao tecnica anterior continua marcada como tecnica, nunca como GGF funcional.

O cadastro nativo SAP solicitado antes desta etapa nao foi implantado por este trabalho. A previa nao instala metadados nem converte a conta tecnica em configuracao padrao.

## Homologacao tecnica do documento: 28/09/2026

Esta secao complementa a previa aprovada abaixo. **Nenhuma das tres OPs esta APTO para gerar documento real.** O novo simulador verifica evidencias e serializa o preco ja calculado; nao altera o motor de rateio nem `RevaluationPreview.ts`. `APTO` significa contrato completo no snapshot examinado, nao garantia de aceitacao pelo SAP: `livePostingValidated=false` e `postingBlocked=true` permanecem inclusive nas fixtures aprovadas.

Evidencias direcionadas: [evidence.json](../.local/ggf/revaluation-evidence-2026-09-28T17-29-44-453Z/evidence.json), [metadata.xml](../.local/ggf/revaluation-evidence-2026-09-28T17-29-44-453Z/metadata.xml). Captura concluida em 28/09/2026 17:30:02 UTC, SBODEMOBR2, TLS verificado, versao `1000340`. Foram 129 GETs, dos quais 12 sondagens de contagem de crossjoin retornaram 400. Essas falhas constam no artefato e NAO foram transformadas em prova de completude. Autenticacao usa Login/Logout; nenhum POST de negocio, instalacao, consulta SQL criada, alteracao de item, OP, recurso, custo, estoque ou diario.

O script `scripts/ggf-revaluation-evidence.mjs` captura as fontes e paginas efetivamente lidas, documentos originais, diarios, contas, regras avancadas e releitura de estabilidade. Examina apenas os dois produtos e o contrato do documento, sem refazer a auditoria do motor ou a composicao de consumo aprovada.

### Metodo, estoque e disponibilidade atuais

| Item / OP | Deposito | Em estoque | Comprometido | Pedido / a receber | Livre fisico (estoque - comprometido) | Custo atual BRL |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| C00003 / 76 | 01 | 4 | 15 | 10 | -11 | 6.867,99 |
| C00003 / 76 | 02 | 100 | 0 | 0 | 100 | 174,66 |
| C00003 / 76 | 03, 04 (cada) | 0 | 0 | 0 | 0 | 0,00 |
| z202604 / 77 e 79 | 01 | -8 | 0 | 10 | -8 | 0,00 |
| z202604 / 77 e 79 | 02, 03, 04 (cada) | 0 | 0 | 0 | 0 | 0,00 |

Fonte: `Items(ItemCode).ItemWarehouseInfoCollection`, campos `WarehouseCode`, `InStock`, `Committed`, `Ordered`, `StandardAveragePrice`. Unidade UN. Totais fisicos conciliados com `QuantityOnStock`: C00003 = 104; z202604 = -8. A disponibilidade de planejamento incluindo pedidos seria -1 e 2 no deposito 01, respectivamente, mas pedidos NAO sao estoque recebido nem quantidade elegivel. Comprometimento negativo liquido de C00003 nao e estoque fisico negativo.

Ambos: `CostAccountingMethod=bis_MovingAverage`, `ManageSerialNumbers=tNO`, `ManageBatchNumbers=tNO`. Nao ha camada FIFO nem identidade de lote/serie aplicavel aos produtos analisados. Custo por deposito confirmado por `CompanyService_GetAdminInfo.PriceSystem=tYES`, inventario permanente `ContinuousStockManagement=tYES`. Nao usar `AvgStdPrice=174.66` global de C00003 no deposito 01.

### Regra de elegibilidade e OP 76

Quantidade elegivel E e a parcela **remanescente comprovada da producao selecionada**, no escopo atual de avaliacao, sem reaproveitar o mesmo saldo entre OPs. Deve conciliar recebimentos liquidos validos, unidade, saidas, devolucoes, transferencias e ajustes ate a leitura atual. Exige `0 < E <= quantidade recebida` e saldo fisico suficiente no escopo, inclusive somando todas as OPs do mesmo item. Nem saldo disponivel comercial, nem saldo global, nem `min(recebido, estoque)` comprovam E.

OP76 = `ProductionOrders(203)`, C00003. Planejada/concluida = 1/1 UN. Recebimento `InventoryGenEntries(109)`, DocNum68, linha0, `BaseType=202`, `BaseEntry=203`, `InventoryQuantity=1`, deposito01, 28/09/2026 08:17, `TransNum=2255`. Custo recebido 5.500,58; custo atual 6.867,99. Nao confundir os dois.

Nas fontes consultadas nao foi encontrada saida ou transferencia posterior a esse recebimento. A ultima saida encontrada foi `InventoryGenExits(74)`, linha11, 1 UN de C00003, deposito01, 25/06/2026 11:14, `BaseEntry=186`, `TransNum=2143`, anterior a OP76. Ha saldos de abertura em `InventoryOpeningBalances(1)/7` (400 UN no01) e `(2)/7` (100 UN no02), em 01/01/2019. As 100 UN no02 nao foram vinculadas a OP76 por transferencia.

Cobertura consultada: InventoryGenEntries, InventoryGenExits, DeliveryNotes, Returns, Invoices, CreditNotes, PurchaseDeliveryNotes, PurchaseReturns, PurchaseInvoices, PurchaseCreditNotes, StockTransfers, InventoryPostings e InventoryOpeningBalances. Foram relidos 66 documentos comerciais/estoque relevantes por chave. As paginas das consultas direcionadas terminaram; as 12 contagens independentes de crossjoin nao sao suportadas pela consulta utilizada. StockTransfers teve 3 documentos, contagem independente 3, nenhum dos dois itens. Releitura de custo/saldo permaneceu igual. Isso nao equivale a um razao de estoque completo, conciliado e transacional.

**Falta para liberar OP76:** uma prova completa e conciliada do fluxo de estoque desde o recebimento ate a data da proposta, cobrindo ajustes/cancelamentos e sequencia de movimentos, e uma regra de atribuicao para produto fungivel quando houver consumo concorrente. Media movel nao guarda reserva de saldo por OP. A hipotese "havia 3, recebeu 1, agora tem 4" e plausivel, mas nao foi promovida a evidencia. Mesmo se E=1 for comprovado, ainda faltam contas efetivas, data/periodo/serie/permissao/dimensoes e aprovacao funcional do pool e do tratamento do saldo inteiro. Portanto nao basta preencher E manualmente.

### OPS 77 e 79: origem do saldo compartilhado negativo

| Data / hora SAP | Entidade / documento / linha | Vinculo | Movimento UN | Saldo reconstruido UN |
| --- | --- | --- | ---: | ---: |
| 07/07/2026 14:27 | Invoices(1053), DocNum445, linha0, TransNum2148 | BaseType17 / BaseEntry1030, venda; WithoutInventoryMovement=tNO | -10 | -10 |
| 28/09/2026 08:21 | InventoryGenEntries(110), DocNum69, linha0, TransNum2259 | BaseType202 / BaseEntry204, OP77 | +1 | -9 |
| 28/09/2026 08:21 | InventoryGenEntries(111), DocNum70, linha0, TransNum2262 | BaseType202 / BaseEntry206, OP79 | +1 | -8 |

Todos no deposito01, item z202604, documentos nao cancelados. Esses movimentos encontrados explicam numericamente o saldo atual: -10 + 1 + 1 = -8. Nenhuma abertura ou outro movimento dos tipos examinados para esse item foi encontrado; a conciliacao numerica nao elimina a ressalva de cobertura do razao acima. Nao foi encontrada movimentacao posterior aos dois recebimentos. O negativo e global **e** do deposito01; outros depositos estao zerados. Nao somar -8 duas vezes pelas duas OPs.

`AdminInfo.BlockStockNegativeQuantity=tNO` permite a situacao de estoque negativo na empresa; nao autoriza alterar preco por reavaliacao nessa situacao. A SAP documenta que o preco de media movel nao pode ser alterado por reavaliacao com estoque negativo. Os recebimentos apenas reduziram o deficit, nao demonstram unidades remanescentes positivas. O simulador bloqueia ambos, sem trocar deposito, usar quantidade pedida, quantidade absoluta ou preco ficticio. [SAP: estoque negativo e custo medio](https://help.sap.com/docs/SAP_BUSINESS_ONE/87e1767ca7584b8f8d60775347637b07/83f68d37c5a24820a7718cd1c264b6f6.html?locale=en-US&state=PRODUCTION&version=10.0).

### Contas comprovadas versus contas ainda nao determinadas

| Evidencia | Conta / nome | O que comprova |
| --- | --- | --- |
| JournalEntries(2255), linha1, OP76 | 1.01.02.01.01 / Mercadorias para Revenda, debito 5.500,58 | Conta de estoque efetivamente debitada naquele recebimento, filial1. Nao garante determinacao futura. |
| JournalEntries(2255), linha0 | 1.01.02.01.03 / Produtos em Elaboracao, credito 5.500,58 | Saida de WIP. O AccountCode da linha de recebimento aponta WIP, nao pode ser tomado como conta de estoque. |
| JournalEntries(2259 e 2262), linha1, OP77/79 | 5.03.01.01.01 / Variacao do Custo Medio, debitos 108,84 e 108,81, dimensao Pr_Acab | Recebimentos debitaram variacao de custo, nao estoque positivo. Creditos em WIP1.01.02.01.03; filial1. |
| Invoices(1053)/0 | 3.01.01.01.02 (AccountCode), 5.02.01.01.01 (COGSAccountCode) | Contas declaradas na venda. Diario2148 nao apresenta linha de baixa de estoque/custo; nao inferir custo positivo. |
| MaterialRevaluation(7)/0, item P20002, 06/05/2024 | 5.03.01.01.04 / Reavaliacao de Custo do Estoque | Contrapartidas historicas de incremento/decremento de OUTRO item. Conta ativa/postavel no cadastro, mas nao selecionada automaticamente para GGF. |

`EnableAdvancedGLAccountDetermination=tYES`, `EnableBranches=tYES`. Os itens usam `GLMethod=glm_WH`; os campos de contas no ItemWarehouseInfo sao nulos e os campos de estoque/incremento/decremento/variacao nos Warehouses01 e grupos100/105 estao vazios. Nao e evidencia de que nao exista determinacao contabil: exige resolver a determinacao efetiva.

GET `GLAccountAdvancedRules` terminou em uma pagina com 4 regras, conciliadas com `/$count=4`: chaves1/3/5/6, itens Z_gás/L10003/S001/S002, periodos2024/2025/2025/2026. Nenhuma regra retornada cita os dois produtos analisados e fornece sua contrapartida de reavaliacao. Nao interpretamos o marcador `!^|` de deposito como deposito real. A leitura das regras nao autoriza reproduzir parcialmente o resolvedor SAP nem presumir contas gerais de fallback. Faltam comprovacao do fallback/determinacao efetiva para item+deposito+data+tipo de conta e validacao das dimensoes obrigatorias.

O metadata possui `CompanyService_GetAdvancedGLAccount` como **Action POST**, com parametros ItemCode, Warehouse, PostingDate, AccountType e demais criterios (BPCode, FederalTaxID, ShipToCountry/State, VatGroup, Usage, UDF1..5). Nao foi chamado. O mesmo vale para actions de periodo e serie. Nenhuma conta real foi inserida no simulador como se estivesse homologada. [Referencia Service Layer, regras avancadas e resolvedor](https://help.sap.com/doc/056f69366b5345a386bb8149f1700c19/10.0/en-US/Service%20Layer%20API%20Reference.html).

### Tratamento separado por metodo

| Metodo | Regra tecnica / bloqueio nesta entrega |
| --- | --- |
| Preco Medio Movel | Custo por deposito comprovado; Price Change P afeta todo saldo do escopo, nao so a OP. Exige saldo positivo, E comprovado, custo vigente, regra do saldo inteiro aprovada e documento completo. Sem isso, payload null. Saldo negativo impede alteracao de preco. |
| FIFO | `RevalType=P` com `FIFOLayers` foi homologado tecnicamente em item FIFO exclusivo em 29/09/2026; ver [prova FIFO](GGF-MATERIAL-REVALUATION-FIFO.md). Exige camadas abertas, sequencia/transacao/camada, quantidade e custo individual. O vinculo da producao GGF com camadas remanescentes continua nao homologado; nenhum item das OPs 76/77/79 fornece caso FIFO. A previa geral por OP segue bloqueada. |
| Preco Padrao | Alteracao de preco padrao e lancamento de debito/credito de estoque tem efeitos contabeis distintos, inclusive variacoes. Precisa homologar metodo, novo padrao e contas apropriadas. Nao reutilizar regra de media movel; metodo nao homologado, sem caso real nestas OPs. |
| Lote / serie | Mesmo com media movel, exige tratamento de identidade/custo/quantidade remanescente especifico. Nenhum identificador inventado. Metodo nao homologado. |

### Simulador estrito de payload

`simulateMaterialRevaluation(preview, evidence)` em `service/MaterialRevaluationPayload.ts` e uma funcao pura sem cliente HTTP. Consome o preco da previa aprovada e NAO recalcula GGF ou custo ajustado. As evidencias sao vinculadas a origem/empresa/apuracao/data do estoque, com referencias nao vazias para custo, saldo, deposito, E/recebimentos, contas efetivas e contexto documental. Esse contrato e uma atestacao de adaptador confiavel, nao prova criptografica nem conjunto de checkboxes para o usuario marcar. Texto em `refs` nao substitui as verificacoes do SAP.

Exige cabeçalho comprovado: metodo homologado, datas validas, serie, periodo aberto, filial, autorizacao, aprovacao funcional e resolucao dos campos condicionais. Exige contas de estoque e ambas contrapartidas ativas/postaveis, determinacao compativel com modo avancado/legado, projeto/dimensoes quando aplicaveis, sem dimensoes duplicadas. Exigir ambas contrapartidas e uma restricao conservadora FactoryOne, nao alegacao de que SAP exige ambas em toda linha P. A payload envia somente a contrapartida do sinal do ajuste.

| Status do documento | Condicao |
| --- | --- |
| APTO | Todas as evidencias, previa e linha SAP consistentes. Documento completo; envio ainda bloqueado. |
| ESTOQUE INSUFICIENTE | Saldo nulo, menor que o requerido, compartilhamento excessivo ou saldo sem evidencia consistente. |
| ESTOQUE NEGATIVO | Quantidade fisica negativa no escopo. |
| MÉTODO NÃO HOMOLOGADO | Metodo nao suportado, contexto documental/funcional incompleto, snapshot divergente ou proposta inconsistente. `problems[].reason` distingue cada caso. |
| CONTA CONTÁBIL AUSENTE | Conta ou determinacao efetiva nao comprovada; nao significa necessariamente cadastro inexistente. |
| DEPÓSITO NÃO DETERMINADO | Falta identidade/evidencia do deposito aplicavel. |
| CUSTO ATUAL NÃO COMPROVADO | Falta evidencia ou custo difere do snapshot. |
| QUANTIDADE ELEGÍVEL NÃO COMPROVADA | Falta prova de remanescente, quantidade ou vinculo dos recebimentos. |

Qualquer linha nao APTO mantem **o documento inteiro null**, sem selecionar silenciosamente um subconjunto. O status principal mostra o primeiro bloqueio; todos os demais ficam em `problems`. Nenhuma validacao remove bloqueios da previa aprovada. A tela acrescenta o status documental ao status de custo ja existente; JSON e painel do documento usam o payload filtrado. Demonstracoes antigas sem atestacao documental tambem ficam sem payload, embora mantenham os calculos de custo aprovados.

Resultado real: [document-simulation.json](../.local/ggf/revaluation-2026-09-28T17-23-55-294Z/document-simulation.json), [preview.json](../.local/ggf/revaluation-2026-09-28T17-23-55-294Z/preview.json), [CSV](../.local/ggf/revaluation-2026-09-28T17-23-55-294Z/preview.csv).

```json
{
  "rows": [
    { "order": "76", "status": "QUANTIDADE ELEGÍVEL NÃO COMPROVADA" },
    { "order": "77", "status": "ESTOQUE NEGATIVO" },
    { "order": "79", "status": "ESTOQUE NEGATIVO" }
  ],
  "payload": null,
  "postingBlocked": true,
  "livePostingValidated": false
}
```

### Payload valido somente em teste controlado

Fixture de `test/ggf/materialRevaluationPayload.test.ts`; TODOS os dados e evidencias abaixo sao ficticios. Contrato completo no simulador, nunca enviado ao SAP. Custo e preco ja vieram da previa matematica; serie7 nao e sugestao para SBODEMOBR2.

```json
{
  "DocDate": "2026-09-30",
  "TaxDate": "2026-09-30",
  "Series": 7,
  "RevalType": "P",
  "Comments": "FactoryOne GGF - PREVIEW ONLY",
  "JournalMemo": "FactoryOne GGF - PREVIEW ONLY",
  "MaterialRevaluationLines": [{
    "ItemCode": "DEV-PROD-D",
    "WarehouseCode": "DEV-WH",
    "Price": 140,
    "RevaluationIncrementAccount": "DEV-INCREASE",
    "Project": "DEV-PROJECT",
    "DistributionRule2": "DEV-D2"
  }]
}
```

Exemplos invalidos: retirar prova de conta, periodo ou E desta fixture; trocar o preco para141 sem corresponder a previa; usar FIFO/padrao; duplicar item/deposito; reaproveitar evidencias de outra data/empresa; usar saldo-8. Todos geram `payload=null`, nunca JSON parcial. Para OP76, mesmo um JSON sintaticamente correto com C00003/01/7141.82 seria invalido: nao ha E/contas/politica homologadas e seu efeito em 4UN seria 1.095,32, nao 273,83.

## Calculos e significados

Sejam G o GGF da OP em centavos, Q a quantidade recebida elegivel na apuracao, E a quantidade remanescente comprovadamente atribuivel a essa producao e C o custo atual aplicavel:

```text
GGF unitario = (G / 100) / Q
Custo ajustado da OP = C + GGF unitario
Custo historico ajustado da OP = materiais originais + recursos originais + G / 100
Parcela estimada para estoque, em centavos = arredondar(G * E / Q)
```

Q e E nao sao a mesma coisa. Q vem dos recebimentos da apuracao; E requer comprovacao posterior do remanescente. Nao usamos `min(Q, saldo)` como evidencia. Nao presumimos que toda producao permaneceu em estoque nem que o saldo atual pertence exclusivamente as OPs selecionadas. Quantidade planejada e informativa, nunca denominador.

Dinheiro e calculado em centavos inteiros (`BigInt`); quantidade/preco usam escala de seis casas. A fracao exata do GGF unitario fica na memoria. A estimativa usa G * E / Q diretamente, nao o preco unitario ja arredondado. O preco serializado no documento e numero JSON (`Edm.Double`), com verificacao de ida e volta para a escala decimal. Diferenca de centavos ou perda nessa conversao bloqueia o documento. As seis casas sao o limite deste contrato; nao substituem homologacao do arredondamento contabil do SAP.

### OP nao e uma camada de estoque

Na alteracao de preco, SAP aplica a diferenca de preco sobre o saldo inteiro do escopo de avaliacao. O custo ajustado individual da OP nao pode virar automaticamente uma linha SAP. O guia SAP diferencia custo por deposito/empresa e o efeito dos metodos Price Change e Inventory Debit/Credit. [Guia de inventario permanente, secao 9](https://help.sap.com/doc/b23e727e45434829a926e6ab06d4b69e/10.0/en-US/How_to_Set_Up_and_Manage_a_Perpetual_Inventory_System.pdf).

Apenas nas fixtures controladas, a politica explicitamente aprovada `spread-over-current-stock` permite:

```text
Valor elegivel do item/deposito = soma das parcelas estimadas das OPs
Preco proposto SAP = custo atual + valor elegivel / saldo inteiro do item/deposito
Efeito conferido = arredondar((preco proposto - custo atual) * saldo, 2)
```

Ha uma unica linha por item/deposito, mesmo se varias OPs produzirem o mesmo item. A soma de quantidades elegiveis nao pode reutilizar o mesmo saldo. O efeito conferido deve ser exatamente o valor elegivel em centavos. Essa politica NAO foi escolhida para SBODEMOBR2: `stockTreatment: null`, e o documento real permanece bloqueado. Multiplos depositos na mesma OP e custo por empresa tambem exigem tratamento especifico nesta versao.

Exemplo ficticio automatizado: OP produziu 2 UN; GGF 3,01; custo atual 10,00; saldo total 4 UN; remanescente comprovado 2 UN. GGF unitario 1,505000; proposta da OP 11,505000. Aplicar esse preco a 4 UN causaria 6,02, duplicando o efeito pretendido. Na politica da fixture, o preco do documento seria 10,752500, com efeito 3,01. Isso nao e regra funcional aprovada para dados reais.

## Fonte do custo e tratamento por metodo

`CompanyService_GetAdminInfo` e uma Function GET confirmada no metadata real. Foram lidos `ContinuousStockManagement`, `PriceSystem`, `LocalCurrency`. Em SBODEMOBR2: `tYES`, `tYES`, `R$`. `PriceSystem` define a possibilidade de reavaliacao por deposito; nao confundir com `Items.ManageStockByWarehouse`, que trata limites de quantidade. [PriceSystem](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~AdminInfo~PriceSystem.html).

| Metodo em Items.CostAccountingMethod | Fonte e tratamento |
| --- | --- |
| bis_MovingAverage | Com custo por deposito, `ItemWarehouseInfoCollection.StandardAveragePrice` no deposito efetivamente recebido; com custo por empresa, `Items.AvgStdPrice`, mas sem documento nesta versao. |
| bis_Standard | O custo padrao e identificado no mesmo campo de custo, mas o documento fica bloqueado: alterar preco padrao e tratar variacoes exige regra propria. |
| bis_FIFO | Sem custo escalar presumido. A prova tecnica `F1FIFO2609281` leu camadas por `MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO` e enviou uma `FIFOLayers.Price`; a previa geral GGF permanece `currentCost: null` ate haver vinculo OP-camada e politica funcional. |
| bis_SNB ou item controlado por lote/serie | Sem custo escalar presumido. Necessarios identificadores e custos dos lotes/series, escopo de avaliacao e saldos. Tratamento especifico, mesmo quando o metodo informado e media movel. |

As propriedades de custo sao descritas pela SAP em [StandardAveragePrice](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~ItemWarehouseInfo~StandardAveragePrice.html) e [AvgStdPrice](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~Items~AvgStdPrice.html). Media de materiais consumidos, preco de tabela, ultimo preco de compra e custo do recebimento nao substituem esses campos de custo atual.

## Leitura real reproduzivel

Entrada aprovada, preservada sem recalcular o motor:

```text
.local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-engine.json
SHA256: 44e7d3613774e280bc30c50eb04f61ab9f34180a0813b41c78304ea473f6b2a3
```

Setembro/2026 ainda nao fechado. Conta `4.01.02.01.01`, Variacoes Cambiais Passivas, **exclusivamente conta de validacao tecnica**. Saldo 379,56; percentual 75%; distribuicao aprovada 284,67. A conta nao e cadastrada como GGF pelo programa.

Primeira captura desta camada: `.local/ggf/revaluation-2026-09-28T16-37-56-092Z/`. Estoque lido em 28/09/2026 16:37:56 UTC; apuracao de origem em 28/09/2026 15:46:34 UTC. HTTPS com certificado verificado, Service Layer `/b1s/v2`, versao retornada `1000340`, empresa SBODEMOBR2. Foram 18 GETs de negocio nesta captura, incluindo releituras; zero escritas de negocio.

Captura final com o codigo entregue: `.local/ggf/revaluation-2026-09-28T17-02-01-374Z/`, mesmos valores e bloqueios. [JSON da previa](../.local/ggf/revaluation-2026-09-28T17-02-01-374Z/preview.json), [CSV](../.local/ggf/revaluation-2026-09-28T17-02-01-374Z/preview.csv), [entrada reproduzivel](../.local/ggf/revaluation-2026-09-28T17-02-01-374Z/input.json). Arquivos financeiros locais continuam ignorados pelo Git.

| OP / chave | Item | Planejada / recebida | Recebimento / linha | Deposito | Materiais | Recursos | Original | GGF |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 76 / 203 | C00003, Quadcore CPU 3.4 GHz | 1 / 1 UN | 109 / 0 | 01 | 1.000,58 | 4.500,00 | 5.500,58 | 273,83 |
| 77 / 204 | z202604, Carcaca do Estator | 1 / 1 UN | 110 / 0 | 01 | 91,84 | 17,00 | 108,84 | 5,42 |
| 79 / 206 | z202604, Carcaca do Estator | 1 / 1 UN | 111 / 0 | 01 | 91,81 | 17,00 | 108,81 | 5,42 |

| OP | Custo atual/deposito | Saldo atual/deposito | GGF unitario | Custo atual + GGF/un | Elegivel | Estimativa reavaliacao | Status |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 76 | 6.867,99 | 4 UN | 273,83 | 7.141,82 | Nao comprovado | Nao comprovada | Dados insuficientes |
| 77 | 0,00 | -8 UN | 5,42 | 5,42 | Nao comprovado | Nao comprovada | Estoque negativo |
| 79 | 0,00 | -8 UN | 5,42 | 5,42 | Nao comprovado | Nao comprovada | Estoque negativo |

Os -8 UN sao o MESMO saldo compartilhado por OP77 e OP79, nao -16 UN. Todos esses itens usam media movel, nao lote/serie. C00003 tem 104 UN somando depositos; 100 UN estao no deposito 02 com custo 174,66. O campo global tambem retorna 174,66, que seria fonte incorreta para o deposito 01 nesta empresa. Atribuir diretamente o preco 7.141,82 ao saldo 4 provocaria efeito 1.095,32, nao 273,83. A tela mostra esse alerta na memoria da OP76.

O custo historico ajustado da OP76 seria 5.774,41, distinto do custo atual unitario acrescido do GGF (7.141,82). Ambos estao identificados separadamente. Os valores aritmeticos das OP77/79 nao tornam estoque negativo apto.

### Rastreabilidade da leitura

| Dado | Fonte / campo / vinculo |
| --- | --- |
| OP, produto, quantidade planejada/concluida, unidade e situacao | `ProductionOrders(203/204/206)`: `AbsoluteEntry`, `DocumentNumber`, `ItemNo`, `PlannedQuantity`, `CompletedQuantity`, `InventoryUOM`, `ProductionOrderStatus`. |
| Recebimentos de 28/09/2026 | `InventoryGenEntries(109/110/111)`, `DocumentLines[LineNum=0]`: `BaseType=202`, `BaseEntry`, `ItemCode`, `TransactionType=botrntComplete`, `InventoryQuantity`, `Quantity`, `UseBaseUnits=tYES`, `MeasureUnit`, `WarehouseCode`; cabecalho `DocDate`, `DocCurrency`, `Cancelled`, `CancelStatus`. |
| Custo atual, metodo, estoque | `Items('C00003')`, `Items('z202604')`: `CostAccountingMethod`, `InventoryItem`, `InventoryUOM`, `AvgStdPrice`, `QuantityOnStock`, `ManageSerialNumbers`, `ManageBatchNumbers`; `ItemWarehouseInfoCollection`: `WarehouseCode`, `InStock`, `StandardAveragePrice`, `Locked`. |
| Custo original e GGF | Resultado aprovado e suas `directCostComponents`, `traces`, `configuration`; referencias dos consumos originais permanecem na memoria JSON. Os consumos antigos nao foram reauditados nesta etapa. |

Leituras por chave nao precisam paginar a raiz. Colecoes filhas com continuacao, IDs duplicados ou ausencia de campos requeridos sao rejeitadas. Soma de estoques dos depositos deve conciliar com `QuantityOnStock`. Recebimentos devem conciliar com quantidade da apuracao/OP, unidade, moeda, vinculo e periodo. O adaptador desta etapa exige OP encerrada e quantidade recebida no conjunto aprovado igual a quantidade concluida acumulada: producao parcial ou repartida entre periodos nao e presumida valida. Releitura dos mesmos campos e da politica detecta alteracoes durante a captura; NAO e snapshot transacional nem garantia contra movimento posterior.

## Contrato futuro Service Layer

Entidade singular confirmada no metadata real: `SAPB1.MaterialRevaluation`, EntitySet **MaterialRevaluation**. Criacao futura: **POST /b1s/v2/MaterialRevaluation**. Metodo implementado somente como proposta: `RevalType: "P"` (Price Change). A API oficial fornece esse tipo e a colecao `MaterialRevaluationLines`. [Referencia Service Layer](https://help.sap.com/doc/056f69366b5345a386bb8149f1700c19/10.0/en-US/Service%20Layer%20API%20Reference.html).

Sondagem direcionada adicional GET em 28/09: `MaterialRevaluation/$count` retornou 4; leitura dos quatro cabecalhos/linhas retornou chaves 7, 16, 17, 18, todas tipo P, sem continuacao. Exemplo historico real: documento 7, 06/05/2024, item P20002, deposito 01, preco anterior 0, novo preco 3.500, saldo 17, `RevalAmountToStock=59500`. Ambas contas de reavaliacao retornaram `5.03.01.01.04`. Essa conta historica NAO foi adotada como contrapartida de GGF. Nenhum desses documentos foi alterado.

| Campo | Contrato da previa e limitacao |
| --- | --- |
| DocDate / TaxDate | Data escolhida funcionalmente, nao preenchida automaticamente para o SAP real. Validar periodo contabil/fiscal aberto antes de futura escrita. |
| RevalType | P na proposta implementada. SAP tambem possui Inventory Debit/Credit; seu codigo, sinais, efeitos e payload ainda nao foram homologados nesta base. Nao existe selecao automatica desse metodo. |
| MaterialRevaluationLines | Pelo menos uma linha por escopo item/deposito; sem linhas duplicadas para OPs do mesmo item. |
| ItemCode | Obrigatorio documentado pela SAP; codigo do produto recebido, nao do recurso/componente. |
| WarehouseCode | Deposito real do recebimento e do custo/saldo, requerido neste contrato por deposito. |
| Price | Preco NOVO, nao incremento; numero JSON de ate seis casas nesta implementacao. |
| Quantity / DebitCredit | Campos confirmados no metadata para o outro metodo. Nao enviados na proposta P; Quantity nao restringe P a quantidade da OP. |
| RevaluationIncrementAccount / RevaluationDecrementAccount | Contrapartida explicitamente verificada conforme sinal do ajuste. Nao inferida da conta do pool GGF nem de um documento antigo. |
| RevaluationIncomeAccount / RevaluationExpenseAccount | Campos de cabecalho presentes no metadata. Nao preenchidos sem regra especifica. |
| Series, Project, DistributionRule ... DistributionRule5 | Existencia confirmada; requisitos de serie, filial, dimensoes e autorizacoes dependem da configuracao real. Nao sao presumidos por esta previa. O metadata consultado nao expunha BPLID nesse cabecalho. |
| DocEntry, DocNum, TransNum | Identificadores esperados do documento futuro, nao inventados na entrada. |
| ActualPrice, OnHand, RevalAmountToStock | Campos de conferencia do resultado; nao usados como forma de impor custo/saldo anterior no payload. |
| FIFOLayers | `TransactionSequenceNum`, `LayerID`, `Quantity`, `Price`, `LineTotal`, `BaseLine`, confirmados no metadata. Nao preenchidos sem camadas comprovadas. |
| SNBLinesCollection | Colecao presente no metadata. Nenhum lote/serie foi inventado. |

O metadata descreve tipos, nao todas as obrigatoriedades contabeis/localizacao. A existencia desses campos e os exemplos antigos nao provam que um POST novo seria aceito. [Propriedades das linhas](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~MaterialRevaluation_lines_members.html), [tipos de reavaliacao](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~MaterialRevaluation~RevalType.html).

### Inventario do contrato capturado e transporte futuro

Metadata SHA256 `64924bc3f46c5d4f8c4a58ce91f6631c04cfed6282e1ab14853ccd312c6065bd`, capturado na homologacao documental. Este inventario separa campos existentes de campos aceitos na proposta P; nao confundir `Nullable` do EDM com obrigatoriedade de criacao. `DocEntry` e chave nao nula GERADA, nao campo que o cliente deve inventar.

| Nivel | Campos confirmados no metadata |
| --- | --- |
| Cabecalho / datas | DocDate, TaxDate, CreationDate, UpdateDate (`DateTimeOffset`), DocTime (`TimeOfDay`). A proposta usa datas ISO; criacao/alteracao/hora ficam a cargo do SAP. |
| Cabecalho / identificacao | DocEntry, DocNum, Series, TransNum, UserSignature (`Int32`); DataSource (`String`). Apenas Series e informado pelo simulador, com evidencia de aplicabilidade. Documento7 usou Series25 em2024, nao prova para2026. |
| Cabecalho / texto e controle | Reference1, Reference2, Comments, JournalMemo, RevalType, RevaluationIncomeAccount, RevaluationExpenseAccount, CardCode, CardName, U_B1SYS_TaxID12 (`String`); InflationRevaluation (`BoYesNoEnum`). Nao preencher campos fiscais/localizados ou contas opcionais sem regra. |
| Cabecalho / colecoes | MaterialRevaluationLines e MaterialRevaluationDocumentReferencesCollection. Referencias de documento nao sao exigidas pela fixture P e nao sao inventadas. |
| Linhas / identidade e contas | LineNum, DocEntry (`Int32`); ItemCode, ItemDescription, WarehouseCode, RevaluationDecrementAccount, RevaluationIncrementAccount (`String`). ItemCode e WarehouseCode sao obrigatorios no contrato FactoryOne por deposito. Nao enviar conta de estoque como campo inexistente: ela e verificada pela determinacao contabil, nao pelo payload da linha. |
| Linhas / valores | Quantity, Price, ActualPrice, OnHand, DebitCredit, RevalAmountToStock (`Double`). Proposta P envia Price NOVO. ActualPrice/OnHand nao sao travas de concorrencia. Quantity nao limita o alcance de uma mudanca de preco. |
| Linhas / alocacao | Project, DistributionRule, DistributionRule2, DistributionRule3, DistributionRule4, DistributionRule5 (`String`). Enviar somente valores comprovados para filial/data/conta; ausencia so pode ser aceita apos resolver sua obrigatoriedade. |
| Linhas / FIFO | FIFOLayers: TransactionSequenceNum, LayerID, BaseLine (`Int32`), Quantity, Price, LineTotal (`Double`). Necessario identificar camadas reais; nenhuma gerada nesta versao. |
| Linhas / lote-serie | SNBLinesCollection: SnbAbsEntry, BaseLine, SystemNumber (`Int32`); NewCost, DebitCredit (`Double`); LotNumber, ManufactureNumber (`String`); AdmissionDate, ExpirationDate (`DateTimeOffset`). Identidade e datas dependem do objeto SAP, nao equivalem a OP. Nenhuma linha SNB gerada. |

Transporte futuro: `POST /b1s/v2/MaterialRevaluation`, `Content-Type: application/json`, `Accept: application/json`, sessao autenticada via cookie B1SESSION e afinidade ROUTEID quando aplicavel. Nao colocar senha, cookie ou sessao no payload/arquivo/exportacao; HTTPS com verificacao TLS. Nao existe funcao de envio implementada. Nao adicionar BPLID/BPL_IDAssignedToInvoice: o cabecalho capturado nao possui esses campos. A filial deve ser validada no deposito e contexto de permissao/serie/dimensoes.

O simulador e conservador: exige provas adicionais mesmo quando SAP poderia preencher defaults. Datas, serie, contas, periodo, autorizacao e campos condicionais ainda nao comprovados mantem payload real null. Antes de qualquer futura criacao sera necessaria nova leitura de estoque/custo/metodo/contas/periodo e nova conciliacao; `stockDate` vincula as evidencias mas nao e bloqueio de concorrencia nem garantia de atualidade indefinida.

As actions `MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO` e `MaterialRevaluationSNBService_GetList` aparecem na API como POST. NAO foram chamadas: esta etapa usa somente GETs de negocio.

### Exemplo de documento exclusivamente ficticio

Este JSON e o candidato matematico da previa anterior, nao um payload aprovado pelo novo simulador documental: faltam serie e atestacoes de contexto. Nunca foi enviado. `TEST-*` nao sao dados SAP nem sugestao de contas. Para o exemplo completo do simulador estrito, ver a secao anterior.

```json
{
  "DocDate": "2026-09-30",
  "TaxDate": "2026-09-30",
  "RevalType": "P",
  "Comments": "FactoryOne GGF - PREVIEW ONLY",
  "JournalMemo": "FactoryOne GGF - PREVIEW ONLY",
  "MaterialRevaluationLines": [
    {
      "ItemCode": "TEST-A",
      "WarehouseCode": "01",
      "Price": 10.7525,
      "RevaluationIncrementAccount": "TEST-INC"
    }
  ]
}
```

Para o caso REAL, `payload=null`, `payloadReady=false`, `estimatedTotal=null`. Nao substituimos esses campos por zeros, contas supostas ou um documento parcial. Mesmo a fixture pronta continua com `postingBlocked=true` e botao desabilitado.

### Respostas e erros futuros

O protocolo Service Layer documenta criacao com HTTP 201 e representacao do objeto; erros de negocio retornam HTTP 4xx e estrutura `error.code`/`error.message`. A resposta de criacao desta entidade ainda nao foi exercitada. [Guia Service Layer](https://help.sap.com/doc/fc2f5477516c404c8bf9ad1315a17238/10.0/en-US/Working_with_SAP_Business_One_Service_Layer.pdf).

Esperados para futura verificacao: sessao expirada/ausente (401); autorizacao insuficiente; JSON/campo invalido; periodo fechado; item/deposito/conta inexistente ou bloqueado; dimensao/projeto obrigatorio; saldo negativo; camada/lote/serie invalido. Erros de negocio podem ser reportados como400 conforme a Service Layer; nao fixamos codigos internos SAP ou mensagens sem observa-los. Falha de transporte/5xx e distinta de rejeicao funcional. Nenhum erro de POST foi provocado para descobrir essas regras.

Na futura homologacao, conferir DocEntry/TransNum, preco efetivo, saldo, valor em estoque, contas e diario gerado contra a previa. Erro de regra, permissao, periodo, conta, saldo ou camada deve manter o processo nao confirmado. Timeout de uma futura escrita exige consulta/reconciliacao antes de repetir: nao implementar retry cego nem supor rollback. Idempotencia e deteccao de GGF ja contabilizado continuam pendentes. Nenhum desses caminhos de escrita foi implementado.

Nesta etapa, falha de GET, origem incorreta, dados instaveis ou incompletos retiram o resultado inteiro. Revisao/AbortController impedem erro antigo e `busy` antigo de substituir a consulta ativa. Mensagens/logs nao expoem credenciais, cookies ou corpo de Login. A captura de AdminInfo retém somente os tres campos de politica necessarios.

## Bloqueios e decisoes pendentes

- Sem saldo, saldo negativo, saldo insuficiente ou saldo compartilhado insuficiente: nao gera documento.
- Falta de custo, unidade, identidade, composicao ou recebimento consistente: dados insuficientes/inconsistencia.
- Quantidade remanescente sem evidencia: dados insuficientes, ainda que haja muito saldo.
- FIFO por OP GGF, serie/lote, custo padrao, custo por empresa ou varios depositos na mesma OP: tratamento especifico pendente. O teste tecnico FIFO de item exclusivo nao remove esse bloqueio funcional.
- Conta tecnica, politica funcional nao aprovada, contrapartida/data nao verificadas: documento bloqueado.
- Sem metodo de tratar GGF da producao vendida/consumida, nao transferir automaticamente seu valor para estoque remanescente.
- Mudancas posteriores de custo, saldo, metodo, contas ou periodo invalidam a proposta. Atualizar a leitura nao atualiza automaticamente a apuracao historica aprovada.

Decisoes exclusivamente funcionais: contas reais do pool e contrapartidas; tratamento do GGF sem estoque remanescente; politica de atribuicao da producao fungivel e eventual distribuicao no saldo inteiro; Price Change versus Inventory Debit/Credit; data/periodo de fechamento; dimensoes/filiais e custos padrao. Provar saldos/camadas e implementar a leitura complementar nao deve ser substituido por uma escolha arbitraria do usuario.

## Como testar e reproduzir

```bash
# Node 24; usa somente as credenciais locais ignoradas em .env
node scripts/ggf-sap-revaluation.mjs .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-engine.json

# Evidencias direcionadas do documento, movimentos, contas e metadados (GET)
node scripts/ggf-revaluation-evidence.mjs

# UI5 em 8081; gateway explicito para a apuracao aprovada em 8083
npm start -- --port 8081
node scripts/ggf-revaluation-preview.mjs .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-engine.json
```

SAP real: `http://localhost:8083/index.html?mode=development&source=sap-read#/ggf/reavaliacao`. Acesso direto requer o gateway iniciado com o arquivo explicito; nao ha escolha automatica da conta tecnica. Cada leitura publica a previa inteira ou erro, sem resultado parcial.

Demonstracao: `http://localhost:8081/index.html?mode=development#/ggf/fechamento` -> Apurar e calcular -> Avancar duas vezes -> Previa de reavaliacao. Clique na OP para ver memoria e recebimentos; exporte CSV ou JSON. Voltar ao fechamento exige nova simulacao; acesso direto demonstrativo sem simulacao nao inventa resultado. URL normal sem modo de desenvolvimento nao consulta SAP nem carrega fixtures.

Cada execucao de terminal cria diretorio ignorado `.local/ggf/revaluation-<timestamp>/` com `capture.json` (respostas e consultas, sem segredos), `input.json` (reproducao offline), `preview.json`, `preview.csv`, `document-simulation.json` (status e evidencias) e `future-payload.json` (null quando bloqueado). Custo/saldo sao atuais, nao fotografia de 30/09. O JSON exportado pela tela preserva origens por componente/recebimento e separa proposta por OP da proposta por escopo. O CSV de rateio anterior foi preservado.

## Arquivos desta etapa

- `webapp/modules/ggf/service/RevaluationPreview.ts`: proposta pura, agrupamento, evidencias e bloqueios.
- `webapp/modules/ggf/service/revaluationExport.ts`: CSV da previa com neutralizacao de formulas.
- `webapp/modules/ggf/repository/SapRevaluationSource.ts`: GETs direcionados, conciliacao e estabilidade.
- `webapp/modules/ggf/development/revaluation.ts`: fixtures explicitas derivadas da simulacao local.
- `webapp/modules/ggf/controller/Revaluation.controller.ts`, `view/Revaluation.view.xml`: tela, memoria, exportacoes e controle de consultas.
- `webapp/modules/ggf/controller/Closing.controller.ts`, `view/Closing.view.xml`, `css/closing.css`, `webapp/manifest.json`: acesso apos simulacao, rota e responsividade Horizon.
- `scripts/ggf-revaluation-runtime.mjs`, `ggf-sap-revaluation.mjs`, `ggf-revaluation-preview.mjs`: captura reproduzivel e gateway local sem escrita.
- `test/ggf/revaluationPreview.test.ts`, `sapRevaluationSource.test.ts`, `test/browser/revaluation.spec.mjs`: regressao da camada nova.

O motor em `webapp/modules/ggf/engine/` nao foi editado. Empacotamento/entrada existentes nao foram redesenhados. Nenhuma instalacao no Web Client foi feita; shell, autenticacao incorporada, permissoes e tamanho do frame real continuam sem validacao nessa hospedagem.

## Verificacoes

Os numeros abaixo registram a etapa anterior da previa. As verificacoes da homologacao documental estao ao final.

- `npm test`: 382 testes em 28 arquivos, todos aprovados. Inclui 45 testes novos desta camada; o wrapper independente anterior tambem executa seus 16 checks Python.
- `npm run typecheck`: aprovado.
- `npm run build`: UI5, extensao, ZIP e MTA gerados. O Make informa clock skew entre ambientes; o processo terminou com codigo zero, e ambos os arquivos compactados passaram em `python3 -m zipfile -t`.
- `npm run test:browser -- --timeout=180000`: 25 testes aprovados, incluindo navegacao anterior, desktop/mobile, cozy, Horizon escuro e alto contraste. A suite de 4 testes da previa foi reexecutada apos os ajustes finais de formatacao e passou novamente.
- Previa real inspecionada no navegador em 1440x1000 e 390x844, incluindo tema escuro; sem erros JavaScript, sem overflow horizontal; confirmacao permanece desabilitada.
- Gateway: requisicao sem opt-in rejeitada com 403; POST local rejeitado com 405 antes de qualquer chamada SAP; origem externa 403; caminho SAP arbitrario 404.
- Reproducao offline de `input.json` gerou JSON identico a captura de referencia, sem acesso de rede.
- `git diff --check` geral ainda aponta CRLF/espacos preexistentes em `.gitignore`, preservados; verificacao dos arquivos novos e do manifest passou.

Capturas SAP reais (datas da leitura visiveis, nenhuma credencial): [desktop](../.local/ggf/revaluation-screenshots/sap-desktop.png), [memoria OP76](../.local/ggf/revaluation-screenshots/sap-detail-desktop.png), [mobile](../.local/ggf/revaluation-screenshots/sap-mobile.png), [mobile escuro](../.local/ggf/revaluation-screenshots/sap-mobile-dark.png).

Conclusao: leitura e calculos da PREVIA verificados; criacao e efeito contabil de MaterialRevaluation NAO homologados. O SAP real permanece com documento futuro nulo por falta de evidencia/regra funcional e estoque negativo nas OP77/79.

## Entrega da homologacao documental

Arquivos criados nesta continuacao:

- `webapp/modules/ggf/service/MaterialRevaluationPayload.ts`: simulador puro, oito status, evidencias e bloqueio integral.
- `scripts/ggf-revaluation-evidence.mjs`: leitura direcionada e rastreavel de estoque, movimentos, contas e contrato.
- `test/ggf/materialRevaluationPayload.test.ts`: 30 casos do novo simulador.

Arquivos alterados nesta continuacao:

- `scripts/ggf-revaluation-runtime.mjs` e `scripts/ggf-sap-revaluation.mjs`: integracao do filtro documental e artefato `document-simulation.json`.
- `webapp/modules/ggf/controller/Revaluation.controller.ts` e `webapp/modules/ggf/view/Revaluation.view.xml`: status documental, painel/JSON filtrados, custo calculado distinto de documento apto.
- `test/browser/revaluation.spec.mjs`: verificacao do bloqueio no modelo, na tela e no JSON exportado, desktop/mobile.
- `docs/GGF-INVENTORY-REVALUATION.md`: evidencias, contrato, regras, limites e reproducao.

O motor `engine/allocation.ts` e o calculo aprovado `service/RevaluationPreview.ts` permaneceram byte a byte iguais (SHA256 respectivamente `d31e2cb13645320ab6c8e4d4252adc783f14ebb6d48bcc024a168b7949e00ae5` e `58caf5e46b02bd335ad780d087a521a9aa4f4e5e2ab398965fc74f06067a0b37`). Alteracoes locais anteriores foram preservadas.

Verificacoes desta continuacao:

- `npm test`: 412 testes em29 arquivos aprovados, incluindo30 novos casos de payload.
- `npm run typecheck`: aprovado.
- `npm run build`: UI5, extensao, ZIP e MTA aprovados. Aviso preexistente de clock skew no Make; codigo de saida zero e integridade de ambos os arquivos confirmada com `python3 -m zipfile -t`.
- Suite completa de navegador: 25 testes aprovados. Os4 testes da previa foram reexecutados apos o ajuste final do rotulo e da exportacao.
- Leitura real no navegador: desktop1440x1000 e mobile390x844, sem erros JavaScript/overflow, botao de criacao desabilitado, nenhum payload. [Desktop](../.local/ggf/revaluation-homologation-screenshots/sap-desktop.png), [mobile](../.local/ggf/revaluation-homologation-screenshots/sap-mobile.png), [assercoes](../.local/ggf/revaluation-homologation-screenshots/checks.json).
- Reproducao offline de `input.json` com simulador separado: `document-simulation.json` identico, sem rede.
- Whitespace dos9 arquivos desta continuacao: aprovado. Nenhuma limpeza das alteracoes preexistentes foi feita.

Conclusao desta continuacao: contrato de leitura, bloqueios e serializacao controlada comprovados; **nenhuma linha real APTO**. Criacao MaterialRevaluation e efeito contabil continuam NAO exercitados. Para OP76, primeiro provar E e resolver determinacao/contexto; para OP77/79, o saldo negativo impede a proposta. Resolver isso exige evidencia e regras funcionais, nao retirar os bloqueios do codigo. Sem instalacao no Web Client.

## Homologacao FIFO posterior (29/09/2026)

A conclusao imediatamente acima descreve a etapa historica da previa por OP. Depois dela, um **cenario tecnico independente** na SBODEMOBR2 homologou um unico `MaterialRevaluation` FIFO por mudanca de preco. Detalhes, payload, documentos, camadas, contas e formulas estao em [GGF-MATERIAL-REVALUATION-FIFO.md](GGF-MATERIAL-REVALUATION-FIFO.md).

Resumo da prova: item exclusivo `F1GGF26F01`, deposito 01, duas camadas abertas (5 UN a R$ 10,00 e 5 UN a R$ 12,00), valor R$ 110,00. `POST /b1s/v2/MaterialRevaluation`, `RevalType=P`, `FIFOLayers` identificando a primeira camada e `Price=10.2` retornou **HTTP 201**, DocEntry **30**, DocNum **6**, TransNum **2282**. Em nova sessao, SAP mostrou a segunda camada inalterada e **uma nova camada de reavaliacao** de 5 UN a R$ 10,20; valor total R$ 111,00. Diario 2282: debito R$ 1,00 em estoque e credito R$ 1,00 na conta de aumento. Diferenca financeira: **zero**. A camada original selecionada deixou de constar entre as abertas; o documento conservou sua sequencia/ID, e a nova camada tem `DocNumber=6`/`DocType=ttInventoryValuation`. A verificacao nao exige identidade de camada estavel apos POST.

Nesta resposta SAP FIFO, `MaterialRevaluationLines.Price`, `ActualPrice` e `RevalAmountToStock` ficaram zero, embora o efeito contabil tenha sido R$ 1,00. `Reference1` voltou `null`; `Comments` e `JournalMemo` persistiram o marcador tecnico. Nao usar esses campos escalares ou `Reference1` como prova de custo, valor ou idempotencia FIFO. O registro persistente do fechamento FactoryOne continua sendo a chave oficial quando houver contabilizacao funcional.

**Limite:** esta prova nao usou OP, nao atribuiu GGF a camada de producao e nao valida producao parcialmente consumida, lote/serie, varios depositos ou reavaliacao por debito/credito. A previa geral GGF e o botao de contabilizacao permanecem bloqueados para FIFO ate o mapeamento OP-camada e a regra funcional serem comprovados. Nao houve segunda reavaliacao.
