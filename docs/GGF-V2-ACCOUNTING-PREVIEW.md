# GGF V2 — Prévia Contábil

## Escopo e segurança

A etapa 6 transforma a divisão da Fase 3 em um plano conceitual de efeitos contábeis. Não modifica o rateio, não cria `MaterialRevaluation`, `JournalEntry`, claim ou documento de fechamento e não possui botão de contabilização. O planejador `buildAccountingPreview` é puro; cada documento/linha expõe `payload: null` e o retorno mantém `postingBlocked: true`.

As OPs reais do período formam o resumo. O cenário FIFO da OP 83 e o ajuste de exemplo de R$ 100,00 ficam num painel separado, fora dos totais do período. Nenhum dado da simulação é apresentado como saldo ou conta funcional.

## Fluxo e documentos previstos

```text
diferença de absorção MOD/GGF
  -> parcela rastreada em estoque -> proposta conceitual MaterialRevaluation
  -> parcela consumida + operação CPV explicitamente elegível -> proposta conceitual Journal Entry CPV
  -> parcelas aptas -> proposta conceitual Journal Entry de fechamento/transitórias
  -> parcela sem destino, conta, método, dimensão ou prova -> bloqueada
```

Os três nomes são famílias de documento, não uma quantidade fixa de documentos. O agrupamento futuro depende de item, depósito, método de avaliação, conta efetiva, filial, dimensões, sinal, política SAP e regra contábil aprovados. Nesta prévia as famílias são independentes e não são convertidas em payload.

As linhas conceituais de fechamento são agrupadas por categoria e combinação exata de dimensões das parcelas aptas. Não há agregação de dimensões distintas numa linha sem dimensão.

Para um valor assinado positivo, o efeito conceitual de estoque é débito em estoque e crédito na transitória da categoria; o efeito de CPV é débito em CPV e crédito na transitória. O fechamento limpa a transitória contra a conta de fechamento MOD/GGF. Valores negativos invertem débito/crédito. Isso é uma representação de conciliação, não uma afirmação sobre a determinação efetiva dos lançamentos do SAP. O `MaterialRevaluation` determina suas contas por configuração SAP e pode gerar documento contábil próprio; a prévia não reproduz uma payload SAP.

## Parametrização explícita

A configuração local, separada do mapeamento de rateio e persistida somente em `localStorage` deste navegador, aceita:

- `transitoryModAccount` e `transitoryGgfAccount`;
- `closingModAccount` e `closingGgfAccount`;
- `cpvAccount`;
- `inventoryAccounts`, indexada por `item/depósito`, como override explícito quando a conta efetiva não puder ser resolvida no SAP;
- `dimensionsByLine`, indexada por `OP/item/depósito/MOD|GGF`;
- `cpvEligibleOperationKeys`, lista de chaves exatas de operação/linha classificadas pelo cliente;
- `requireDimensions`, que por padrão permanece `true`.

Conta vazia, código malformado, dimensão obrigatória ausente, classe CPV não aprovada ou chave de operação ausente bloqueia a parcela afetada. Contas são códigos; descrição nunca seleciona uma conta. Overrides locais são identificados como configuração FactoryOne e não como determinação SAP.

## Determinação contábil SAP

A leitura somente GET da etapa coleta a origem/candidatos para auditoria:

- `CompanyService_GetAdminInfo`: `EnableAdvancedGLAccountDetermination`;
- `Items('<item>')`: `GLMethod` e `ItemsGroupCode`;
- `Warehouses('<depósito>')`: `StockAccount`, `IncreaseGLAccount` e `DecreaseGLAccount`;
- `ItemGroups(<código>)`: `InventoryAccount`, `IncreaseGLAccount` e `DecreaseGLAccount`.

Quando a política indica determinação avançada, a UI mostra `SAP_ADVANCED_GL_ACCOUNT_DETERMINATION` como origem, mas não declara a conta efetiva resolvida. O adaptador não invoca `CompanyService_GetAdvancedGLAccount` nem tenta reproduzir parcialmente suas regras. A falta de determinação efetiva exige conta explicitamente configurada e aprovada; a configuração FactoryOne não substitui uma conta de reavaliação SAP exigida no documento.

Contas transitórias, CPV e fechamento MOD/GGF são sempre decisão de configuração do cliente. A conta de estoque e contas de incremento/decremento exibidas como candidatas são apenas metadados lidos; não provam o efeito para item, depósito, data, sinal e política completos. Dimensões/filial também não são inferidas.

## Modelo de memória

Cada linha preserva, quando disponível: `ClosingId`, versão, OP, item, depósito, conta GGF/MOD original, categoria, critério, quantidade/unidade, parcela estoque/consumido, refs de origem e dimensões. `ClosingId`/versão continuam nulos no relatório técnico enquanto a apuração não foi persistida como fechamento; isso não cria vínculo artificial.

A apuração por categoria usa centavos inteiros e conserva o sinal:

```text
total a absorver = estoque apto + CPV apto + bloqueado
diferença = total a absorver − estoque − CPV − bloqueado = 0
débito previsto = crédito previsto (somente efeitos conceituais aptos)
```

Saldo sem OP elegível, alocação não distribuída, lineage incompleta ou valores sem split reconciliado entram como bloqueados. A mesma linha não pode ser contada simultaneamente em estoque e consumido sem `stockCents + consumedCents = amountCents`.

## Status

- `READY_FOR_STOCK_REVALUATION` e `READY_FOR_CPV_ADJUSTMENT`: prévia conceitual apta, sem payload.
- `ACCOUNTING_CONFIG_INCOMPLETE` / `CPV_ACCOUNTING_NOT_CONFIGURED`: contas, dimensão obrigatória ou contrapartida ausente.
- `STOCK_TRACE_INCOMPLETE`: faltam quantidades, depósito ou reconciliação da divisão.
- `CPV_CLASSIFICATION_MISSING`: operação exata não está na lista de operações elegíveis.
- `NEGATIVE_STOCK`: item ou depósito com saldo negativo.
- `VALUATION_METHOD_NOT_HOMOLOGATED`: método diferente do FIFO já rastreado não reutiliza a regra.
- `BLOCKED`: linha não apta por mais de uma lacuna ou valor inconsistente.

Qualquer linha não apta fica de fora dos efeitos conceituais e seu valor permanece na parcela bloqueada. Não há fallback de débito/crédito.

## Prova técnica SBODEMOBR2

A leitura de setembro/2026 usa as OPs 76, 77 e 79, sem escrita. Os três itens são `bis_MovingAverage`; OP 76/C00003 tem saldo compartilhado agregado em vários depósitos, e OP 77/79 compartilham z202604 com saldo -11 no depósito 01. Fase 3 já bloqueia a atribuição por OP; nesta fase essas parcelas continuam em `STOCK_TRACE_INCOMPLETE`, `VALUATION_METHOD_NOT_HOMOLOGATED` ou `NEGATIVE_STOCK`, sem proposta financeira.

Execução desta fase: consulta somente leitura concluída em 2026-09-30T19:54:39Z (SBODEMOBR2). O escopo técnico existente leu a conta `4.01.01.04.07` como GGF e `R300007/Cost1` como MOD, para OPs 76/77/79. Essa conta é exclusivamente um mapeamento de homologação técnica previamente usado; não foi selecionada como GGF funcional nem aprovada para uso no fechamento. Resultado observado: MOD permaneceu `BLOCKED_NO_ACCOUNT` (0 centavos alocados; -300.000 centavos residuais); GGF retornou `CALCULATED_TECHNICAL` e -616.600 centavos alocados pela regra de custo direto de homologação. Esses números provam apenas a execução/leitura e o comportamento do rateio, não a elegibilidade contábil do pool.

Na revisão de estoque, OP 76/C00003 retornou quantidade agregada 104, mas `BLOCKED_AMBIGUOUS_TRACE`; OP 77 e OP 79/z202604 retornaram -11 e `BLOCKED_STOCK_NEGATIVE`. Os três itens indicaram método `bis_MovingAverage` e origem de determinação avançada (`EnableAdvancedGLAccountDetermination=tYES`); os candidatos de conta por depósito vieram vazios/nulos e `inventoryAccount` permaneceu nulo/não verificado. Assim, nenhuma das três OPs gerou linha apta ou payload em Stage 6. O cenário FIFO técnico independente da OP 83 também permaneceu fora do período e sem conta funcional/classificação CPV.

A evidência anterior de determinação contábil registrou `EnableAdvancedGLAccountDetermination=tYES` e `GLMethod=glm_WH` nos itens observados. Campos de contas de depósito/grupo estavam vazios, e quatro regras avançadas existentes não identificaram contrapartida para esses itens. A existência de regras não prova ausência de fallback ou da conta efetiva. A prova desta fase deve reler política e candidatos sem invocar o resolvedor SAP. Nenhuma conta das OPs 76/77/79 é escolhida por semelhança de descrição.

A OP 83 é apenas demonstração isolada: ajuste exemplo de 10.000 centavos, 4.000 na camada FIFO e 6.000 consumidos. Sem configuração de inventário, transitória, fechamento, conta CPV e classificação exata da saída, a prévia de exemplo mostra tudo bloqueado. Ela não altera os totais funcionais do mês nem declara a saída como CPV.

## Testes

`test/ggf/accountingPreview.test.ts` cobre somente estoque, somente CPV explicitamente classificado, estoque + consumido, MOD e GGF, CPV/transitória ausente, negativo, lineage ausente, preço médio móvel, superabsorção, arredondamento, reconciliação e payload sempre nulo. Playwright cobre desktop/mobile e verifica a etapa 6, determinação avançada não resolvida, bloqueios e totais reais simulados pela fixture de navegador.

## Pendências funcionais

1. Aprovar contas transitórias e contas de fechamento distintas para MOD/GGF.
2. Definir conta CPV e classificar operações específicas por uso (venda, consumo interno, perda, transferência, estorno); tipo de documento isolado não torna uma saída CPV.
3. Resolver e comprovar contas efetivas SAP por item, depósito, data, sinal, filial e regra de determinação avançada.
4. Definir dimensões obrigatórias e valores por linha; aprovar filial/centros.
5. Homologar o tratamento contábil de preço médio móvel, FIFO e preço padrão, inclusive contrapartidas produzidas pelo SAP.
6. Decidir regras de agrupamento, datas, reversão e vínculo final ClosingId/versão/hash com cada documento futuro.

Até essas decisões e evidências existirem, a interface serve como conciliação e lista de bloqueios. Não é pré-aprovação para contabilizar.
