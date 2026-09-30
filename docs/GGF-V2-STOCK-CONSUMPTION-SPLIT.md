# GGF V2 — Estoque x Consumido

## Escopo desta fase

Esta fase acrescenta uma prévia matemática posterior à alocação da diferença de custo real menos custo padrão. MOD e GGF permanecem separados, não há POST de `MaterialRevaluation`, `JournalEntry` ou outro documento, e nenhum estoque, custo ou OP é alterado. A resposta do cálculo mantém `payload: null`.

O novo divisor não modifica o motor nem as alocações das Fases 1 e 2. Ele só aceita quantidades positivas e conciliadas, método conhecido, unidade/depósito e evidência de origem adequada. A conta é feita em centavos inteiros. Para cada componente:

```text
ajuste unitário = ajuste da OP / quantidade originalmente produzida elegível
ajuste em estoque = arredondar(ajuste da OP × saldo rastreado / quantidade originalmente produzida)
ajuste consumido = ajuste da OP − ajuste em estoque
```

O divisor é sempre a quantidade produzida elegível, nunca o saldo remanescente. O resíduo de centavos fica na parcela consumida; portanto estoque + consumido reconcilia exatamente, inclusive para valores negativos. Não há soma de unidades incompatíveis.

## Evidência de origem e movimentações

Para uma OP geral, o saldo atual de `Items.QuantityOnStock` ou `ItemWarehouseInfoCollection.InStock` não demonstra qual recebimento daquela OP ainda está no estoque. Um vínculo OP → item → recebimento não prova, sozinho, o destino de cada saída posterior.

O cenário FIFO técnico existente da OP 83 é deliberadamente separado do rateio funcional. A leitura estritamente limitada confere:

- `ProductionOrders(214)`: OP número 83, item e `CompletedQuantity`;
- `InventoryGenEntries(122)`: `DocEntry`, `DocNum`, `DocDate`, linha, `BaseType`, `BaseEntry`, item, `InventoryQuantity` e depósito do recebimento;
- `InventoryGenExits(90)`: documento/linha, data, item, `InventoryQuantity` e depósito da saída observada;
- `Items('F1GGF26P01')`: `CostAccountingMethod`, `InventoryUOM`, saldo e saldo por depósito;
- ação somente de leitura `MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO`: sequência/camada da camada correspondente ao recebimento, depósito e `OpenQty`.

O caso só é aceito se OP, recebimento, camada e saída permanecerem iguais aos valores técnicos previamente homologados: 10 UN recebidas, 6 UN emitidas, 4 UN abertas na camada FIFO e 4 UN no depósito 01. Se alguma evidência mudar, a API não reaproveita o resultado antigo: o cenário aparece bloqueado.

O saldo geral das OPs da Fase 2 é lido novamente em `Items` para exibir método de avaliação e quantidades por depósito. Essa leitura não fecha a reconciliação de saídas. A interface bloqueia a divisão daquelas OPs e registra que não houve conciliação completa de entregas, saídas, transferências e outras movimentações posteriores. O conjunto de documentos que precisa ser considerado inclui, conforme o tipo de movimento habilitado no processo, `InventoryGenExits`, `DeliveryNotes`, `Returns`, `Invoices`, `CreditNotes`, `StockTransfers`, `InventoryPostings` e documentos de entrada/devolução que possam alterar o saldo. A lista não significa que cada entidade seja automaticamente uma saída elegível.

## Leitura real SBODEMOBR2

Leitura realizada em 30/09/2026 via rota local protegida `GET /__ggf/v2/distribution`, período 01/09/2026–30/09/2026, companhia retornada `SBODEMOBR2`, conjunto técnico 76/77/79. Nenhum documento de negócio foi enviado. O motor V2 retornou as três OPs; a etapa de estoque releu os itens por `Items('<ItemCode>')` e confirmou:

| OP | Item | `CostAccountingMethod` | `InventoryUOM` | `QuantityOnStock` | `WarehouseCode / InStock / Committed` | Status de divisão |
|---|---|---|---|---:|---|---|
| 76 | C00003 | `bis_MovingAverage` | UN | 104 | 01 / 4 / 15; 02 / 100 / 0; 03 / 0 / 0; 04 / 0 / 0 | `BLOCKED_AMBIGUOUS_TRACE` |
| 77 | z202604 | `bis_MovingAverage` | UN | -11 | 01 / -11 / 0; 02 / 0 / 0; 03 / 0 / 0; 04 / 0 / 0 | `BLOCKED_STOCK_NEGATIVE` |
| 79 | z202604 | `bis_MovingAverage` | UN | -11 | 01 / -11 / 0; 02 / 0 / 0; 03 / 0 / 0; 04 / 0 / 0 | `BLOCKED_STOCK_NEGATIVE` |

Disponível exibido é `InStock − Committed`; para C00003, o depósito 01 resulta em -11 disponíveis apesar de saldo físico positivo 4. O saldo de z202604 é o mesmo item compartilhado pelas OPs 77 e 79 e **não deve ser somado nem atribuído a nenhuma delas**. O negativo é global para esse item nesta leitura e localizado no depósito 01; os outros depósitos estão zerados. As três linhas permanecem bloqueadas por preço médio móvel sem lineage por OP; 77/79 também têm o bloqueio adicional de estoque negativo.

Na leitura de controle separada, a OP 83 continuou conciliada em FIFO: `ProductionOrders(214)`, `InventoryGenEntries(122)` DocNum 77 linha 0, 10 UN recebidas em 29/09/2026 no depósito 01; `InventoryGenExits(90)` DocNum 40 linha 0, 6 UN emitidas; a ação de leitura FIFO identificou sequência 2792/camada 0 com `OpenQty = 4` e `CurrentCost` lido na resposta. O item `F1GGF26P01` retornou método `bis_FIFO`, unidade UN e 4 em estoque no depósito 01. Com ajuste de demonstração separado de 10.000 centavos (R$ 100,00), o cálculo independente da divisão retornou 4.000 centavos em estoque e 6.000 centavos consumidos, diferença zero, `payload = null`. A emissão foi rastreada quantitativamente, mas sua natureza contábil não foi configurada; o status correto é `CONSUMED_UNCLASSIFIED`, não CPV.

A chamada `MaterialRevaluationFIFOService_GetMaterialRevaluationFIFO` usa HTTP POST porque é uma ação da Service Layer, mas é usada exclusivamente como operação de leitura: não cria nem altera documentos. Nenhum POST de negócio foi realizado.

Para uma homologação geral ainda é necessário obter uma extração paginada, por item, depósito e período, com contagem de controle independente, cancelamentos/estornos e linhas completas. Transferências devem ser conciliadas em origem e destino e não podem virar consumo. Documento de saída só pode ser classificado como CPV por uma regra funcional explícita. Nesta fase não há operação configurada como CPV; quantidade consumida é exibida como consumo sem classificação contábil.

## Métodos de avaliação

| Método SAP | Comportamento nesta fase |
|---|---|
| `bis_FIFO` | Candidato de estoque somente quando o recebimento e a camada original reconciliam. Mais de uma camada/recebimento sem alocação composta permanece bloqueada. A parcela consumida não é automaticamente CPV. |
| `bis_MovingAverage` | Identifica o método e pode exibir saldos correntes, mas não atribui o saldo agregado a uma OP. A origem por camada não existe no método; permanece bloqueado sem uma regra de pool e movimentações comprovadas. |
| `bis_Standard` | Identifica o método, mas não reutiliza a regra FIFO ou preço médio. Tratamento de custo padrão requer regra contábil própria e permanece bloqueado. |
| desconhecido | Bloqueado. |

Preço médio móvel não implica rastreabilidade de origem por OP. A demonstração FIFO não homologa nem altera o fluxo de preço médio móvel já testado para reavaliação.

## Status e segurança

- `STOCK_REVALUATION_CANDIDATE`: há saldo FIFO rastreado; é uma candidatura matemática, não um payload nem autorização de documento.
- `CPV_ADJUSTMENT_CANDIDATE`: só pode ser produzido quando uma classificação explícita de operação elegível indicar `CPV_ELIGIBLE`.
- `CONSUMPTION_UNCLASSIFIED`: a quantidade saiu do saldo rastreado, mas não existe classificação contábil autorizada.
- `BLOCKED_STOCK_NEGATIVE`, `BLOCKED_ZERO_PRODUCTION`, `BLOCKED_QUANTITY_DIVERGENCE`, `BLOCKED_AMBIGUOUS_TRACE`, `BLOCKED_METHOD_NOT_HOMOLOGATED`: valores por parcela não são publicados.

Os nomes “candidato” não liberam a contabilização. O botão/fluxo de contabilização permanece bloqueado. Nenhum payload de reavaliação é gerado.

## Interface

O fechamento V2 acrescenta a área **5. Estoque x Consumido**:

- linhas das OPs alocadas mostram método e saldo atual por depósito, quando lidos;
- movimentação incompleta e método sem tratamento permanecem com status bloqueado e motivo visível;
- o painel expansível da OP 83 apresenta recebimento, saída e camada FIFO observados, quantidade produzida/consumida/remanescente e memória separada MOD/GGF;
- o painel identifica o ajuste de R$ 100,00 como exemplo técnico separado, sem conta GGF funcional;
- a parcela consumida do exemplo não é declarada CPV, pois a saída não está configurada como operação elegível.

## Casos automatizados

`test/ggf/stockConsumptionSplit.test.ts` verifica produção integral disponível, produção integral consumida, consumo parcial, sinal negativo, resíduo de centavos, zero produção, divergência de quantidades, estoque negativo, método médio móvel, preço padrão, ausência de camada FIFO reconciliada, recebimentos/saídas/depósitos ambíguos e classificação explícita antes de candidatar CPV. `test/ggf/fifoPreviewRead.test.ts` verifica a leitura controlada da OP 83 e a recusa de dados alterados. O Playwright cobre a apresentação responsiva da lista bloqueada e do painel FIFO técnico.

## Limitações e decisões pendentes

1. Definir quais naturezas de saída, por tipo de documento e uso empresarial, podem gerar ajuste de CPV.
2. Homologar leitura completa e independente de movimentos e cancelamentos para cada entidade habilitada.
3. Definir comportamento para vários recebimentos/camadas, depósitos e itens controlados por lote/série.
4. Definir o tratamento de custo padrão e uma regra de pool para preço médio móvel, se necessária.
5. Validar com o cliente a relação entre ajuste unitário da produção, estoque remanescente e CPV, incluindo períodos abertos.

Até essas decisões e leituras serem comprovadas, OPs sem lineage integral continuam bloqueadas e não podem gerar valores de estoque/CPV por presunção.
