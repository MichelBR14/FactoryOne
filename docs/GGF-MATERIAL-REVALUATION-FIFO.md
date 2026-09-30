# MaterialRevaluation FIFO: homologacao controlada

## Estado da prova

Em 28/09/2026, a SBODEMOBR2 recebeu o cenario exclusivo. Em 29/09/2026, apos nova leitura de camadas, entradas, diarios, contas, periodo e estoque, foi executado **um unico POST real** de `MaterialRevaluation`: HTTP 201, DocEntry **30**, DocNum **6**, TransNum **2282**. A releitura em nova sessao conciliou estoque, camadas e diario com **diferenca zero**. Nenhuma segunda reavaliacao foi criada. Diario de intencoes, previa, resposta e releitura estao, respectivamente, em `.local/ggf/fifo-F1FIFO2609281-{state,preview,post,verify}.json` (ignorados pelo Git). Nao houve uso das OPs 76, 77 ou 79.

Este e um **teste tecnico de estoque FIFO**, nao um fechamento GGF funcional. O item nao foi produzido por OP, e as contas resolvidas pertencem a determinacao contabil da base demo; nao classificar este valor como gasto indireto industrial. A contabilizacao geral do FactoryOne e o botao da interface continuam bloqueados.

## Cenario e origem

| Dado | Evidencia SAP em 28/09/2026 |
| --- | --- |
| Identificador | `F1FIFO2609281`, reservado somente a esta homologacao |
| Item | `F1GGF26F01`, criado exclusivamente, `Items.CostAccountingMethod=bis_FIFO`, `InventoryUOM=UN`, sem lote/serie |
| Local | Deposito `01`, filial 1; `Warehouses('01')`, ativo e nao drop-ship |
| Politica | `CompanyService_GetAdminInfo`: inventario permanente, custo por deposito, determinacao contabil avancada |
| Periodo e serie | `CompanyService_GetFinancePeriod(179)`: 2026-09 aberto; `SeriesService_GetDefaultSeries(162)`: serie 25 nao bloqueada |
| Entrada 1 | `InventoryGenEntries(118)`, DocNum 75, TransNum 2279, linha 0: 5 UN a R$ 10,00; total R$ 50,00 |
| Entrada 2 | `InventoryGenEntries(120)`, DocNum 76, TransNum 2280, linha 0: 5 UN a R$ 12,00; total R$ 60,00 |

Os diarios `JournalEntries(2279)` e `JournalEntries(2280)` corroboraram independentemente as entradas: debito na conta de estoque `1.01.02.01.01` de R$ 50,00 e R$ 60,00, respectivamente; credito na conta de entrada `5.03.01.01.03` pelos mesmos valores, sempre na filial 1. A conta de aumento de reavaliacao resolvida por `CompanyService_GetAdvancedGLAccount(iatGLIncrease)` foi `5.03.01.01.04` (*Reavaliacao de Custo do Estoque*). A conta de estoque aparece como *Mercadorias para Revenda* na base demo, outra razao para nao apresentar este teste como contabilizacao industrial aprovada.

## Camadas antes

Leitura por `POST MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO` com `MaterialRevaluationFIFOParams={ItemCode:"F1GGF26F01",LocationCode:"01",LocationType:"64",ShowIssuedLayers:"tNO"}`. Este POST e uma **action de leitura**, nao cria documento. A [API Service Layer](https://help.sap.com/doc/056f69366b5345a386bb8149f1700c19/10.0/en-US/Service%20Layer%20API%20Reference.html) e o [exemplo FIFO da SAP](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~MaterialRevaluationFIFOService.html) descrevem esse contrato.

| Camada | `TransactionSequenceNum` | `LayerID` | `DocNumber` | Qtd. aberta | Custo | Valor aberto |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2789 | 0 | 75 | 5 UN | R$ 10,00 | R$ 50,00 |
| 2 | 2790 | 0 | 76 | 5 UN | R$ 12,00 | R$ 60,00 |
| **Total** | | | | **10 UN** | | **R$ 110,00** |

`TransactionSequenceNum` e `LayerID` identificam a camada conjuntamente; `DocNumber` correspondeu aos DocNums das duas entradas. A soma das quantidades abertas igualou `Items.ItemWarehouseInfoCollection(01).InStock=10`. Nenhuma camada foi consumida neste cenario.

## Ajuste enviado

Alterar **somente a camada 2789/0** de R$ 10,00 para R$ 10,20. Conta independente em centavos: `5 * 1.000 + 5 * 1.200 = 11.000`; delta `5 * (1.020 - 1.000) = 100`; valor esperado depois `11.100` centavos. Camada 2790/0 permanece em 5 UN a R$ 12,00. O simulador isolado `previewFifoRevaluation` tambem retorna `FIFO_APTO`, 11.000/100/11.100 centavos e somente uma `FIFOLayers` no payload. O roteiro compara ambos antes de habilitar o transporte.

```json
{
  "DocDate": "2026-09-28",
  "TaxDate": "2026-09-28",
  "Series": 25,
  "RevalType": "P",
  "Reference1": "F1FIFO2609281",
  "Comments": "FactoryOne FIFO homologacao F1FIFO2609281",
  "JournalMemo": "FactoryOne FIFO homologacao F1FIFO2609281",
  "MaterialRevaluationLines": [{
    "ItemCode": "F1GGF26F01",
    "WarehouseCode": "01",
    "RevaluationIncrementAccount": "5.03.01.01.04",
    "FIFOLayers": [{ "TransactionSequenceNum": 2789, "LayerID": 0, "Price": 10.2 }]
  }]
}
```

Para `RevalType=P`, `FIFOLayers.Price` e o **novo preco da camada**. `Quantity` e `LineTotal` na sublinha sao do metodo de debito/credito e nao foram inventados aqui; o campo escalar `MaterialRevaluationLines.Price` usado para preco medio nao foi reutilizado. [Propriedades FIFO da SAP](https://help.sap.com/doc/089315d8d0f8475a9fc84fb919b501a3/10.0/en-US/SDKHelp/SAPbobsCOM~FIFOLayers_members.html). `Reference1` foi enviado para leitura humana, mas retornou **null** no GET; nao e identidade persistente nem mecanismo de idempotencia. `Comments` e `JournalMemo` conservaram o identificador. O fechamento FactoryOne continua dependendo de sua chave propria/claim, nao desses textos.

## POST real e releitura

O envio iniciou em **2026-09-29 11:05:21.886 UTC** e a resposta chegou em **11:05:23.092 UTC**: HTTP **201**, `DocEntry=30`, `DocNum=6`, `TransNum=2282`. O documento lido novamente por `MaterialRevaluation(30)` mostrou `RevalType=P`, serie 25, item `F1GGF26F01`, deposito 01, conta de aumento `5.03.01.01.04`, e sua sublinha `FIFOLayers` referenciou **2789/0** com novo preco **R$ 10,20**.

| Camada aberta apos o POST | Origem | Qtd. | Custo | Valor |
| --- | --- | ---: | ---: | ---: |
| 2790/0 | Entrada DocNum 76, inalterada | 5 UN | R$ 12,00 | R$ 60,00 |
| 2791/0 | Reavaliacao DocNum 6, `ttInventoryValuation` | 5 UN | R$ 10,20 | R$ 51,00 |
| **Total** | | **10 UN** | | **R$ 111,00** |

O SAP nao manteve a identidade da camada 2789/0 como camada aberta: criou **2791/0** vinculada ao documento 6. A action com `ShowIssuedLayers=tNO` e com `tYES` retornou essas mesmas duas camadas abertas; neste metodo, o parametro nao ofereceu uma linha historica adicional para 2789/0. A prova de origem combina a sublinha do documento 30 (camada antiga 2789/0), a nova camada com `DocNumber=6` e `DocType=ttInventoryValuation`, as quantidades/custos, e a camada 2790/0 intacta. O verificador inicial exigia erroneamente identidade inalterada e foi corrigido **sem outro POST**.

`MaterialRevaluationLines.Price`, `ActualPrice` e `RevalAmountToStock` voltaram **0** no GET desse documento FIFO. Nao usa-los como prova do efeito financeiro deste metodo. A prova contabil foi `JournalEntries(2282)`: **debito R$ 1,00** na conta de estoque `1.01.02.01.01`; **credito R$ 1,00** na conta `5.03.01.01.04`, ambas na filial 1. A quantidade em estoque continuou 10 UN. Conta independente: `11.100 - 11.000 = 100` centavos; debito = credito = 100 centavos; diferenca final **0**. O verificador final exige o vinculo da camada antiga na sublinha, a camada nova identificada pelo DocNum 6, a outra camada preservada e os dois lados do diario.

## Bloqueios e seguranca

`FIFO_APTO` requer item/filial/deposito/periodo/conta comprovados, estoque nao negativo, soma das camadas igual ao estoque, identidade e origem de cada camada, quantidade elegivel igual a quantidade **aberta** da camada selecionada e reconciliacao da previa em centavos. A funcao retorna `payload=null` para `FIFO_CAMADA_NAO_IDENTIFICADA`, `FIFO_CAMADA_FECHADA`, `FIFO_QUANTIDADE_INSUFICIENTE`, `FIFO_ESTOQUE_NEGATIVO` ou `FIFO_DADOS_INCOMPLETOS`. Nao ha fallback de horas, custo medio ou camada presumida. O roteiro tecnico grava `POST_INTENT` antes de qualquer envio, impede segunda tentativa e trata perda de resposta como `POSTING_UNCERTAIN`, exigindo reconciliacao antes de agir.

O teste de camada parcialmente consumida usa apenas `OpenQty` comprovada, nunca a quantidade original integral. No metodo `P`, a mudanca de preco afeta toda a quantidade ainda aberta da camada; se o ajuste funcional precisar atingir somente parte dela, a previa bloqueia esse payload. A [documentacao SAP](https://help.sap.com/doc/b23e727e45434829a926e6ab06d4b69e/10.0/en-US/How_to_Set_Up_and_Manage_a_Perpetual_Inventory_System.pdf) distingue isso do metodo debito/credito, que pode desdobrar uma camada parcialmente reavaliada. Permanece pendente a politica funcional para a parcela da producao ja consumida; este teste tecnico nao a define.

## Comparacao e pendencias

Em preco medio movel, a homologacao anterior usou um custo escalar do item/deposito e `MaterialRevaluationLines.Price`. FIFO exige leitura das camadas abertas, vinculo com a origem e `FIFOLayers` identificadas. O custo global/medio exibido no item nao substitui o valor de cada camada.

**Homologacao tecnica FIFO de uma camada aberta, por mudanca de preco: passou.** O rastreamento de producao e consumo parcial foi comprovado depois, em outro item tecnico, abaixo. Ainda nao ha rateio GGF funcional por OP FIFO, multiplos depositos, lote/serie, nem debito/credito em vez de `P`. A queda da Service Layer em 28/09 interrompeu a etapa antes do POST; na retomada, uma nova previa e sua releitura imediatamente anterior ao envio mantiveram o mesmo conteudo. Nenhuma segunda `MaterialRevaluation` foi criada.

Verificacoes locais da etapa inicial: **466/466** testes unitarios em 33 arquivos, `npm run typecheck` e `npm run build` aprovados; **4/4** testes Playwright relevantes da previa de reavaliacao aprovados em desktop/mobile. O build gerou `mta_archives/ext-factoreone_0.1.0.mtar` com aviso de *clock skew* do WSL. Os testes FIFO cobrem uma camada, multiplas camadas, consumo parcial, camada fechada/nao identificada, quantidade insuficiente, estoque negativo, arredondamento, payload incompleto e conciliacao por camada/conta, inclusive a substituicao de identidade observada no SAP. As verificacoes apos o ajuste da reconciliacao estao registradas ao final desta etapa.

Verificacoes finais em 29/09/2026, apos a reconciliacao real: **466/466** testes unitarios, `npm run typecheck` aprovado, `npm run build` aprovado e **4/4** testes Playwright relevantes aprovados. O aviso de *clock skew* do WSL permaneceu no build sem falha de comando. O diario local registra um `POST_INTENT` e um resultado `POSTED` para o identificador; a releitura SAP encontrou exatamente um documento com o marcador tecnico. Nenhum segundo POST foi executado.

## Producao FIFO parcialmente consumida: prova separada em 29/09/2026

Com autorizacao explicita para **criar cenario tecnico sem reavaliacao**, foi criado o item exclusivo `F1GGF26P01` (`bis_FIFO`, `UN`, sem lote/serie), BOM com recurso `R300011`, OP, recebimento e saida tecnica. Nao se tocou no item reavaliado `F1GGF26F01` nem nas OPs 76/77/79. O roteiro `scripts/ggf-fifo-production-trace.mjs` registra cada intencao de escrita em `.local/ggf/fifo-production-F1FOP2609291-state.json`, nao repete etapas automaticamente e exige releitura antes da etapa seguinte. A evidencia atual e reproduzivel em leitura por `node scripts/ggf-fifo-production-trace.mjs verify`, no Node 24. Este comando nao cria documento.

| Elo | Entidade/campo SAP | Prova |
| --- | --- | --- |
| OP | `ProductionOrders(214)`: `DocumentNumber=83`, `ItemNo=F1GGF26P01`, `PlannedQuantity=10`, `CompletedQuantity=10`, status fechado | Marcador `F1FOP2609291`, deposito 01, filial 1 |
| Recebimento | `InventoryGenEntries(122)`, DocNum 77, `TransNum=2284`, `DocumentLines[0]`: `BaseType=202`, `BaseEntry=214`, item, deposito 01, `InventoryQuantity=10` | R$ 12,00/UN; `LineTotal=120` |
| Movimentacao contabil de entrada | `JournalEntries(2284)` | Debito R$ 120 em `1.01.02.01.01`, credito R$ 120 em `1.01.02.01.03` |
| Camada gerada | `MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO`, item e deposito 01 | `TransactionSequenceNum=2792`, `LayerID=0`, `DocNumber=77`, `DocType=ttGeneralReceiptToStock`, `EntryDate=2026-09-29`, custo R$ 12/UN |
| Saida parcial | `InventoryGenExits(90)`, DocNum 40, `TransNum=2286`, linha 0 | 6 UN, R$ 72, deposito 01; `JournalEntries(2286)` credita estoque `1.01.02.01.01` em R$ 72 e debita `5.03.01.01.03` em R$ 72 |
| Camada apos saida | Mesma action de leitura, mesma identidade 2792/0 | `OpenQty=4`, `CurrentCost=12`: R$ 48 abertos; `Items.QuantityOnStock=4` e deposito 01 `InStock=4` |

Assim, o elo **OP 214 → recebimento 122/linha 0 → DocNum 77 → camada 2792/0** foi observado. Quantidade original 10 UN; quantidade consumida `10 - 4 = 6 UN`, corroborada pelo documento de saida; valor original `10 × 1.200 = 12.000` centavos; valor aberto `4 × 1.200 = 4.800`; valor consumido `6 × 1.200 = 7.200`; diferenca `12.000 - 4.800 - 7.200 = 0`. O item exclusivo tinha uma unica camada aberta, de modo que a saida parcial e a reducao da camada coincidem; isto **nao generaliza** para itens com estoque anterior, multiplas camadas, transferencias ou movimentos concorrentes. `ShowIssuedLayers` nao foi usado para afirmar um historico integral das camadas fechadas. O recurso `R300011` foi apropriado a R$ 12/UN no custo direto; `JournalEntries(2285)` no fechamento da OP incluiu `4.01.01.04.07`, mas **essa conta nao foi tratada como GGF**. A releitura tambem confirma que nao ha `MaterialRevaluation` com o marcador deste cenario.

### Previa conceitual sem contabilizacao

Para **GGF ficticio exclusivamente matematico de R$ 100,00**, `GGF unitario = 10.000 centavos / 10 UN = 1.000 centavos/UN`. Parcela atribuivel ao estoque comprovadamente aberto: `4 × 1.000 = 4.000 centavos`; parcela das 6 UN ja consumidas: `6 × 1.000 = 6.000 centavos`. Nao se divide R$ 100 pelas 4 UN remanescentes. A funcao `previewFifoProduction` usa a quantidade **original** como divisor, conserva o total em centavos com residuo deterministico e retorna `payload=null` em todos os estados. Neste cenario retorna `FIFO_PARTIALLY_CONSUMED`; os outros estados sao `FIFO_FULLY_AVAILABLE`, `FIFO_FULLY_CONSUMED`, `FIFO_LAYER_NOT_FOUND`, `FIFO_MULTIPLE_LAYERS` e `FIFO_TRACE_AMBIGUOUS`. Uma camada sem prova historica de origem nao e classificada automaticamente como totalmente consumida.

O contrato de rastreio guarda `ClosingId`, OP `DocEntry`, recebimento `DocEntry` e linha, item, deposito, identidade original `(TransactionSequenceNum, LayerID)`, quantidade remanescente, eventual `RevaluationDocEntry`/`DocNum` e identidade resultante. Uma camada substituta so e aceita se seu `DocNumber` e `DocType` corresponderem ao documento de reavaliacao relido. A prova atual foi persistida **somente no arquivo local ignorado pelo Git** `.local/ggf/fifo-production-F1FOP2609291-evidence.json`, com `closingId`, `revaluationDocEntry`, `revaluationDocNum` e `resultLayer` nulos. Para **fechamentos futuros**, `PostingBasis.fifoLineage` agora permite persistir essa lista no campo nativo `U_PostingBasis` do header e inclui-la no `PostingHash`; sem a lista, o hash legado nao muda. Isso ainda **nao foi gravado/homologado em um fechamento SAP real** e nao substitui a prova de origem no momento da contabilizacao. Antes de qualquer POST futuro, sera preciso preencher um `ClosingId` real, reler a lista persistida e testar integridade, tamanho e versionamento do campo no SAP. A substituicao de identidade apos reavaliacao, observada no teste anterior, exige preservar ambas as chaves.

### Caminhos contabeis ainda pendentes

**A, saldo em estoque:** a reavaliacao por preco de uma **camada FIFO aberta** foi comprovada no teste anterior. Para este novo caso, a eventual variacao teria de incidir somente sobre as 4 UN abertas, com nova verificacao de estoque e identidade imediatamente antes do envio. Nenhum documento foi proposto/enviado nesta etapa.

**B, parcela ja consumida:** nao ha camada aberta a reavaliar para as 6 UN. A [documentacao SAP sobre custos de producao](https://help.sap.com/docs/PRODUCT_ID/68a2e87fb29941b5bf959a184d9c6727/689975f9caea438ba98206fce1573bcb.html) explica que, **para variancias nativas da OP ao fecha-la**, a parte ja vendida nao e reavaliada no estoque e, em FIFO, pode permanecer em conta de variancia WIP. Isso **nao prova** que um GGF apurado posteriormente deva usar essa mesma conta ou mecanismo. Os [assistentes de recalculo de custo de producao](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727/8501c399f1f546e9ab64186b52fb8b47.html) e de [lucro bruto/CMV](https://help.sap.com/docs/SAP_BUSINESS_ONE/21a663bcb9b2414e8ef39e9c39c22694/053173363ae643be98f9124358299e82.html) existem, mas sua aplicabilidade documentada se concentra em componentes avaliados por lote/serie e documentos comerciais; **nao foi comprovada para este GGF FIFO**. Um lancamento de ajuste de despesa/CMV ou de variancia seria outra proposta funcional-contabil a homologar, nao uma consequencia automatica deste teste. Nenhum desses caminhos foi executado ou escolhido.

**Pendencias para produto naquele momento:** provar rastreio em item com multiplas camadas/entradas, transferencias e consumo comercial; definir contabilmente a parcela consumida com o cliente; homologar gravacao/releitura e versionamento da linhagem no UDO nativo; integrar a leitura da camada e os novos estados na previa do Web Client. As duas ultimas etapas tecnicas foram executadas depois, conforme a secao seguinte. A contabilizacao geral e FIFO GGF permanecem bloqueados.

Verificacoes daquela etapa inicial: releitura `verify` em nova sessao Service Layer aprovada, inclusive ausencia de `MaterialRevaluation` com o marcador; **473/473** testes unitarios, `npm run typecheck` e `npm run build` aprovados. O build em WSL manteve apenas o aviso de *clock skew*. Naquele ponto, a persistencia nativa de `fifoLineage` ainda requeria teste de gravacao/releitura; a secao seguinte registra essa homologacao posterior.

## Vinculo FIFO no fechamento e na previa local

Em 29/09/2026, `PostingBasis.fifoLineage` passou a conter snapshot por OP/item/recebimento: `closingId`, versao, OP `DocEntry`/`DocNum`, recebimento `DocEntry`/`DocNum`/linha, item, deposito, quantidade produzida, camada original (sequencia/ID, quantidade, custo), quantidade aberta/consumida, valor aberto, `traceStatus` e instante de captura. `RevaluationDocEntry`, `RevaluationDocNum`, camada resultante, sua quantidade e custo ficam **nulos** ate existir uma reavaliacao futura. O hash inclui os componentes funcionais, nao o instante nem a numeracao administrativa da versao. As linhas de auditoria ganham nova versao quando `fifoLineage` muda. O teste tecnico nativo e seus limites de snapshot historico estao em [GGF-CLOSING-LIFECYCLE.md](GGF-CLOSING-LIFECYCLE.md#fifo-posting-basis-validacao-tecnica-de-29092026).

A funcao `previewFifoProduction` usa `GGF_total_OP / quantidade originalmente produzida`, nunca `GGF_total_OP / quantidade remanescente`. Calcula a parcela do estoque em centavos com arredondamento deterministico, e a parcela consumida como residuo; assim `GGF_estoque + GGF_consumido = GGF_total_OP` mesmo quando o quociente por unidade tem fracoes de centavo. `FIFO_STOCK_REVALUATION_CANDIDATE` indica apenas que ha camada aberta passivel de investigacao; nao significa documento apto. `FIFO_CONSUMED_GGF_PENDING_ACCOUNTING_RULE` impede usar o valor consumido na reavaliacao da camada aberta. Todos os resultados retornam `payload=null`. A classificacao por OP marca multiplos recebimentos/camadas como `FIFO_MULTIPLE_LAYERS`, exigindo atribuicao por camada antes de qualquer proposta. Camada ausente, duplicada ou de origem contraditoria bloqueia a previa; ausencia de camada aberta **nao prova por si so** consumo total.

Na previa local do Web Client em `mode=development&source=sap-read`, a secao **Rastreabilidade FIFO · cenario tecnico** rele a OP 83, recebimento, saida, item e camada pela Service Layer no momento da consulta. Mostra 10/6/4 UN, status e memoria expandida sem expor `TransactionSequenceNum` na tabela principal. O exemplo de R$ 100 e rotulado como **nao funcional** e fica fora dos totais das contas/OPs reais. A Service Layer voltou `FIFO_PARTIALLY_CONSUMED`, R$ 40 de potencial em estoque e R$ 60 pendentes de regra, sempre com `payloadReady=false`. Se uma leitura nao conciliar, essa secao nao mostra dado antigo. A tela ainda nao agrega automaticamente qualquer OP FIFO de um fechamento funcional; isso depende de configuracao GGF aprovada e rastreio de todas as suas camadas.

### Parcela consumida: alternativas investigadas, sem escolha

- **Variancia nativa da OP:** a [documentacao SAP de Production Costing](https://help.sap.com/docs/PRODUCT_ID/68a2e87fb29941b5bf959a184d9c6727/689975f9caea438ba98206fce1573bcb.html) afirma que, se parte do produto ja saiu antes do fechamento da OP, apenas a parte ainda disponivel pode ser reavaliada por aquela variancia, e a parcela consumida pode permanecer em variancia WIP para FIFO. **Inferencia limitada:** isso nao demonstra que um GGF apurado depois possa ser inserido como variancia da OP ja fechada; nao utilizar essa conta automaticamente.
- **Recalculo de custo/CMV por assistentes SAP:** os [assistentes de recálculo de producao](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727/8501c399f1f546e9ab64186b52fb8b47.html) e [lucro bruto/CMV](https://help.sap.com/docs/SAP_BUSINESS_ONE/21a663bcb9b2414e8ef39e9c39c22694/053173363ae643be98f9124358299e82.html) tratam discrepancias de custo em escopos documentados que envolvem avaliacao por lote/serie e documentos comerciais. Este cenario e FIFO com **saida manual**, nao venda; nao foi comprovado que esses assistentes reconhecam GGF retroativo aqui.
- **Lancamento complementar:** tecnicamente um Journal Entry pode registrar uma despesa/variancia, mas ainda nao foi definida a conta de debito, contrapartida, dimensoes, periodo, tratamento tributario nem a relacao com CMV. A saida tecnica atual debitou `5.03.01.01.03` apenas pelo **custo original R$ 72**, e isso nao autoriza debitar automaticamente os R$ 60 hipoteticos nessa conta. Nenhum Journal Entry foi criado.
- **MaterialRevaluation:** `RevalType=P` so alcança as **4 UN ainda abertas** da camada. Colocar os R$ 100 integrais nesse saldo daria R$ 25/UN e violaria a regra de producao original; os R$ 60 consumidos nao tem estoque a reavaliar.

Nao se encontrou, nas fontes SAP consultadas nem na base tecnica, um mecanismo comprovado que contabilize automaticamente GGF retroativo sobre quantidade FIFO ja consumida mantendo a trilha OP → saida → conta correta. Essa parcela permanece bloqueada ate decisao contabil/funcional e homologacao especifica. Nao usar comportamento presumido de solucoes de mercado como prova do SAP nesta base.

O fechamento tecnico `F1HL260929F` agora possui snapshots FIFO completos das versoes 1 e 2 no UDO `FBO_GGF_CVERS`, vinculados a linhas separadas de `FBO_GGF_CLINE`. A prova de releitura, hashes e limites operacionais esta em [GGF-CLOSING-LIFECYCLE.md](GGF-CLOSING-LIFECYCLE.md#fifo-posting-basis-validacao-tecnica-de-29092026). Verificacoes finais: 479 testes unitarios, typecheck, build e 29 testes de navegador aprovados. A instabilidade intermitente do endpoint do UDO novo ainda requer atencao operacional; nenhum documento financeiro foi criado nesta etapa.
