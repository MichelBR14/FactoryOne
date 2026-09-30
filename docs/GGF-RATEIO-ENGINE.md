# GGF - motor de rateio em validacao

## Estado desta entrega

Etapa posterior executada: [primeira validacao real ponta a ponta](GGF-REAL-RATEIO-VALIDATION.md),
sem modificar o motor. Os resultados abaixo preservam o historico da etapa de
implementacao; a prova real posterior esta documentada separadamente.

Os quatro criterios usam o motor existente, ampliado sem substituir seu algoritmo
de centavos inteiros. Nao ha contabilizacao, reavaliacao, atualizacao de custo,
estoque, OP ou recurso. `ClosingSession.confirm()` continua lancando
`postingBlocked`. Nenhuma configuracao contabil oficial foi escolhida.

Simulacao: assistente SAPUI5 em
`http://localhost:8081/index.html?mode=development#/ggf/fechamento`.
Dados `DEV-*`, repositorio e armazenamento locais separados da Service Layer.
O aviso de dados ficticios permanece visivel; nenhuma falha SAP aciona fallback.

Leitura real: novo comando `ggf:sap:calculate`, exclusivo para **SBODEMOBR2**,
com selecao explicita em arquivo local. A previa SAP na porta8082 continua sendo
a conferencia de fontes existente; o novo calculo real e executado por comando,
com memoria JSON/CSV, nao foi ligado automaticamente ao botao de conferencia.
Nao se refez a auditoria generica nem se escolheu conta real para executar um
rateio sem instrucao do usuario.

## Configuracao por conta

`AccountRule`: `account`, `name`, `classificationId`, `percent`, `criterion`,
`active`. Percentual aplicavel entre0 e100, com ate duas casas. Grupos usam
`GroupShare`: `account`, `group`, `percent`, `basis`.

Novos cadastros e fixtures trazem percentual100 explicito. Apenas configuracoes
legadas sem o campo conservam o comportamento anterior100%; a carga local
migra esse campo. Valor vazio, null, negativo, acima100 ou com precisao maior
nao e convertido em100. O caminho SAP exige o percentual explicitamente.
Descricoes e classificacoes sao obrigatorias; contas/grupos duplicados bloqueiam.

```text
V = saldo contabil da conta no periodo (debito - credito)
p = percentual total aplicavel
A = arredondar_para_centavos(V * p / 100)
```

`A`, nao `V`, entra no criterio. O percentual nao altera o saldo contabil.
Saldos credores preservam o sinal: nao se aplica modulo nem se elimina credito.
Um percentual zero nao autoriza inventar base; criterios ativos ainda precisam
de base verificavel. Conta inativa nao entra no calculo.

## 1. Distribuicao por Grupo de Recurso

Os percentuais dos grupos de cada conta devem somar exatamente100%. Nao ha
redistribuicao silenciosa da quota de um grupo sem base para outro grupo.

```text
A_grupo = A * percentual_grupo / 100, com ajuste de centavos entre grupos
participacao_OP_no_grupo = base_OP_grupo / soma_bases_do_grupo
GGF_OP_grupo = A_grupo * participacao_OP_no_grupo
GGF_OP_conta = soma das parcelas da OP nos grupos dessa conta
```

A base interna e explicita por grupo: `HOURS` (horas reais),
`RESOURCE_QUANTITY` (consumo comprovado, com unidade e comparabilidade) ou
`RESOURCE_VALUE` (valor registrado de consumo de recurso, moeda comum).
Nao ha troca automatica de base. Configuracoes antigas sem `basis` continuam
usando HOURS. Valor de recurso como **denominador** nao transforma esse custo
em **gasto do pool GGF**.

Somente OPs relacionadas ao grupo participam. Ausencia comprovada de relacao
nao e base faltante; ja uma OP relacionada sem medida comprovada bloqueia.
Grupo com percentual positivo, mas sem OP/base positiva, bloqueia mesmo que
sua quota monetaria arredonde para zero. Grupo com percentual0 nao exige base.
Horas por grupo continuam conciliadas com o total de horas da OP quando presentes.

Exemplo controlado: conta10.000,00, aplicabilidade100%, ENVASE20% e USINAGEM80%.
ENVASE: OP A tem1 unidade, OP B tem3 =>500,00 /1.500,00.
USINAGEM: OP B tem1, OP C tem3 =>2.000,00 /6.000,00.
Resultado A500,00; B3.500,00; C6.000,00. Total10.000,00, diferenca0.
Unidades desse exemplo sao ficticias e comparaveis dentro de cada grupo.

## 2. Horas Apontadas

```text
participacao_OP = horas_reais_OP / soma_horas_reais_OPs_elegiveis
GGF_OP = A * participacao_OP
```

Unidade normalizada obrigatoria `h`, escopo e origem comprovados.
Planejamento, datas de abertura/fechamento, backflush, `TimePerUnits` e
`UnitsPerTime` nao sao apontamentos. Falta de horas nao vira zero nem e suprida
por quantidade ou valor de recurso.

Na base tecnica de setembro/2026 nao ha fonte validada de horas reais para as
tres OPs. O adaptador novo devolve `hours=null`, evidencia null e motivo
explicito. HOURS e grupo/HOURS bloqueiam; os outros criterios nao precisam
fabricar horas para poder funcionar.

## 3. Absorcao por Custo Direto

```text
participacao_OP = custo_direto_OP / soma_custos_diretos_OPs_elegiveis
GGF_OP = A * participacao_OP
```

Os componentes ficam em `directCostComponents`, com tipo, codigo, valor e
referencia documental. Sua soma deve coincidir com o custo usado. Para dados
SAP a composicao e obrigatoria. A memoria e o CSV exibem os componentes.

No adaptador real, a politica opcional e explicita
`DOCUMENTED_MATERIALS_AND_RESOURCES`: soma de `LineTotal` das saidas de materiais
e recursos efetivamente vinculadas a OP. Isso usa a composicao tecnica ja
levantada, **nao aprova a natureza economica da tarifa nem a regra oficial de
GGF**. Sem selecionar essa politica, custo direto permanece indisponivel.
Tarifa atual de cadastro, preco medio do item e total de debitos do fechamento
nao substituem custo direto. Valores negativos/retornos fora do mapeamento
validado bloqueiam a fonte em vez de serem ignorados.

Exemplo controlado: saldo1.000,00, percentual25% =>250,00 a distribuir.
Bases10.000/20.000/30.000 =>41,67 /83,33 /125,00. Saldo original1.000,00
permanece na memoria, assim como a parcela aplicavel250,00.

## 4. Quantidade Produzida

```text
participacao_OP = quantidade_recebida_OP_no_periodo / soma_quantidades_comparaveis
GGF_OP = A * participacao_OP
```

Unidade igual nao basta: `unit` e `comparisonKey` devem coincidir. Conversoes
precisam de uma regra explicita em `normalizationRef`, origem e fatores
comprovados pelo adaptador. O motor recebe medidas ja normalizadas; nao inventa
fatores para conciliar produtos distintos. Quantidade planejada nao e utilizada.

Leitura real atual: mesma unidade de estoque e mesmo `ItemNo`, `UseBaseUnits=tYES`,
`InventoryQuantity=Quantity`, recebimento de produto concluido e quantidade
conciliada com `CompletedQuantity` dentro do ciclo validado. OPs77/79 podem
compartilhar a base de quantidade; incluir OP76, de outro produto, bloqueia
sem regra de equivalencia. Conversoes reais entre produtos/unidades ainda nao
foram implementadas, logo nao sao presumidas.

## Memoria e arredondamento

Valores monetarios e bases sao inteiros escalados: dinheiro em centavos,
quantidade/horas com ate seis casas; percentuais com duas casas.

1. Aplicabilidade: uma unica aproximacao para centavos, meio centavo afastando
   de zero, simetrica para negativos. Guarda-se o ajuste como numerador sobre
   10.000 de centavo. Exemplo0,01 x50% =>0,01, ajuste+5.000/10.000 de centavo.
2. Quotas dos grupos: maiores restos, preservando sinal; empates pelo codigo
   estavel do grupo. Registra-se o residuo e o ajuste em centavos do grupo.
3. Dentro do grupo/conta: maiores restos, empates pelo ID estavel da OP. Nenhuma
   dependencia da ordem das linhas. OP com base comprovadamente zero recebe0.
4. Conciliacao por conta e global: `valor_aplicavel - total_distribuido = 0`.
   Qualquer diferenca provoca erro, sem publicar resultado parcial.

A participacao exibida tem seis casas percentuais, apenas para leitura. O
calculo usa a fracao exata `basis/totalBasis`, nao esse percentual arredondado.
Por isso a soma dos percentuais exibidos pode diferir minimamente de100%; a
soma monetaria nao difere. No criterio de grupos, a participacao e **dentro da
quota do grupo**; a OP pode ter varias parcelas na mesma conta.

Memoria por conta: saldo, percentual, aplicavel, ajuste de aplicabilidade,
distribuido e diferenca. Por parcela: conta, classificacao, criterio, grupo,
percentual do grupo, saldo original, percentual da conta, aplicavel, quota,
tipo/unidade da base, base OP, base total, participacao, resto fracionario,
ajuste de centavos e valor final. A quota/ajuste de grupo aparece em cada linha
para rastreio; **nao somar essa coluna repetida como novo ajuste por OP**.

Snapshot, filtros, origem, configuracao, leituras completas, referencias,
componentes e bases por grupo ficam retidos. CSV inclui essas secoes e protege
identificadores contra formulas de planilha. Na tela, expandir **Memoria de
calculo** na etapa3; os totais por criterio/conta refletem o percentual aplicavel.

`currentCost=null` produz `current=null` e `resulting=null`, nunca custo zero ou
GGF apresentado como custo final do item. O calculo matematico pode funcionar
sem valorizacao atual de estoque; isso nao libera contabilizacao.

## Fontes SAP e limites do caminho real

Somente leitura, sessao existente com TLS verificado e empresa restrita a
SBODEMOBR2. POST apenas Login/Logout. O comando nao importa fixtures.
`SapGgfCalculationSource` reutiliza a paginacao de `MappedGgfSource`, sem chamar
a auditoria generica ou instalar consultas/metadados.

| Fonte | Campos usados | Escopo e uso |
|---|---|---|
| ChartOfAccounts | Code, Name | Somente contas ativas explicitamente selecionadas; existencia antes de aceitar saldo zero |
| JournalEntries | JdtNum, ReferenceDate, JournalEntryLines.AccountCode/Debit/Credit/Line_ID | Setembro por ReferenceDate; extrai apenas saldos das contas selecionadas; preserva debito menos credito |
| ProductionOrders | AbsoluteEntry, DocumentNumber, ItemNo, InventoryUOM, CompletedQuantity, PostingDate, ClosingDate, tipo/status, ProductionOrderLines | Chaves escolhidas dentre203/204/206; ordem padrao fechada dentro do periodo |
| InventoryGenEntries | DocEntry, DocDate, moeda/cancelamento, DocumentLines.BaseType/BaseEntry/ItemCode/TransactionType/Quantity/InventoryQuantity/MeasureUnit/UseBaseUnits | Recebimentos no periodo; apenas produto concluido da OP; sem retornos presumidos |
| InventoryGenExits | DocEntry, DocDate, moeda/cancelamento, DocumentLines.BaseType/BaseEntry/BaseLine/ItemCode/ItemType/Quantity/LineTotal | Consumo vinculado por chave e linha; quantidade confere com IssuedQuantity de cada componente |
| Resources / ResourceGroups | Code, Group, UnitOfMeasure / Code, Name | Cadastro atual de grupo e unidade, sem reconstruir tarifa historica |

Moeda `SAP_LOCAL` no contrato real identifica explicitamente os valores locais
observados; nao se declarou uma conversao ISO/cambial. Documentos dessa leitura
restrita devem retornar `DocCurrency=R$`; outros valores bloqueiam o escopo.

Cada colecao tem IDs distintos, paginacao esgotada e `$count` separado, repetido
ao final. Continuacoes em colecoes aninhadas bloqueiam. `requestPath`,
`controlPath` e `scope` ficam na evidencia: cadastros sao atuais, nao consultas
historicas supostamente filtradas por data. Referencias de apoio ligam a base a
OP/recurso/grupo; linhas lidas mas nao usadas sao registradas explicitamente em
`excludedSourceRefs` com regra de exclusao. Nao se perde cobertura da coleta.

Limites atuais: somente setembro/2026, subconjunto das OPs76/77/79, sem filtro
de filial/dimensao, sem equivalencia entre produtos e sem fonte validada de
horas. Registro e quantidade de consumo dos recursos nao comprovam horas.
Quantidade interna de grupo real so e disponibilizada se, dentro da OP, houver
um mesmo recurso com unidade cadastrada compativel; entre OPs, recurso/unidade
tambem devem ser comparaveis. R300010/R300011 sem unidade nao satisfazem isso.
Valor de consumo por grupo pode estar disponivel independentemente dessas horas.

Nao ha snapshot transacional. Contagens nao provam que valores ficaram imutaveis
durante todas as consultas. A composicao da tarifa, dupla absorcao e selecao de
contas seguem o [diagnostico funcional aprovado](GGF-FUNCTIONAL-DIAGNOSTIC.md).
Nenhuma coincidencia monetaria libera uma regra contabil ou atualizacao de custo.
O saldo selecionado inclui todas as origens, com seus sinais. Ainda nao existe
regra aprovada para excluir absorcoes, variancias ou lancamentos de GGF de outros
sistemas; a selecao de uma conta nao comprova que seu saldo seja elegivel.

### Executar com selecao explicita

O comando recebe um JSON ignorado, dentro de `.local/ggf/`, contendo:

```json
{
  "company": "SBODEMOBR2",
  "filter": {"start": "2026-09-01", "end": "2026-09-30", "branch": "", "costCenter": ""},
  "selection": {"orderEntries": [204, 206]},
  "configuration": {
    "classifications": [{"id": "VALIDACAO", "name": "Validacao funcional"}],
    "accounts": [{"account": "CONTA_A_ESCOLHER", "name": "Descricao a conferir", "classificationId": "VALIDACAO", "percent": "100", "criterion": "QUANTITY", "active": true}],
    "groupShares": []
  }
}
```

O codigo de conta acima e **placeholder, nao conta real ou recomendacao**. Deve
ser substituido pela escolha explicita do usuario. Para custo direto, incluir
`selection.directCostPolicy="DOCUMENTED_MATERIALS_AND_RESOURCES"` e selecionar
DIRECT_COST. Para grupos, selecionar RESOURCE_GROUP e informar `groupShares`
com grupo, percentual e base interna, sem criar percentuais oficiais automaticamente.

```sh
npm run ggf:sap:calculate -- .local/ggf/calculation-request.json
```

Saidas ignoradas: `calculation-result.json` e `calculation-memory.csv`.
BigInts no JSON sao strings de **unidades escaladas**; CSV formata valores
decimais. Resultados antigos sao removidos ao iniciar. Falha na leitura ou no
calculo grava `calculation-blocked.json` com codigo e motivo; pedido local
invalido interrompe antes da autenticacao, sem criar resultado. Mensagem de base ausente:
**"Base de rateio indisponivel para o periodo."** (com acentos na aplicacao).
Leitura interrompida nao publica total parcial. Credenciais permanecem somente
na configuracao local ignorada; nao fazem parte do JSON de selecao nem do CSV.

## Cenarios e verificacoes

`allocation.test.ts`, `rateioEngine.test.ts`, `sourceEvidence.test.ts`,
`sapCalculationSource.test.ts` e `workflow.test.ts` cobrem:

- Quatro criterios, grupos20/80 com consumo comprovado, horas, custo e quantidade.
- Aplicabilidade por conta, zero/negativo, percentuais invalidos e multiplas contas.
- OP de base zero versus OP com base ausente; total zero; grupo sem OP.
- Grupos somando diferente de100%; grupo zero sem exigir horas indisponiveis.
- Arredondamento em aplicabilidade, grupos e OPs; sinal; desempate deterministico;
  valores acima da precisao segura de Number.
- Unidades/produtos incompativeis, contrato explicitamente normalizado,
  composicao do custo divergente, falta de horas sem fallback e custo atual null.
- Fonte SAP com respostas inventadas: saldos, vinculos, escopo, unidades,
  contagem alterada, paginacao incompleta, cancelamentos e bloqueio de escrita.
- Origem/filtros, invalidacao, concorrencia, exportacao e confirmacao bloqueada.

`ggf-engine.spec.mjs` cobre percentual editavel, base interna do grupo, memoria,
composicao e bloqueio no navegador desktop/mobile. A suite de navegador bloqueia
acesso externo/SAP; esses testes nao sao validacao contra o servidor real.

Verificacao executada em 28/09/2026, usando Node 24 no WSL:

- `npm test`: 335 testes aprovados em 25 arquivos.
- `npm run typecheck`: aprovado.
- `npm run build:module`: aprovado, incluindo geracao da extensao Web Client.
- `npm run build`: aprovado com o MBT Linux 1.2.47 do ambiente temporario.
  Gerou `mta_archives/ext-factoreone_0.1.0.mtar` (525843 bytes) e
  `resources/factoreoneapp.zip` (542613 bytes); ambos passaram no teste de
  integridade `python3 -m zipfile -t`. O Make emitiu aviso de clock skew no
  filesystem Windows/WSL. Antes disso, a chamada ao MBT global Windows saiu
  sem gerar artefato novo e nao foi considerada verificacao de build.
  O pacote foi construido, nao instalado nem validado dentro do Web Client.
- `node --check scripts/ggf-sap-calculate.mjs`: aprovado.
- `npm run test:browser`: 20 de 21 testes aprovados na execucao completa.
  O teste de navegacao com cinco recargas excedeu o limite de 90 segundos
  enquanto o build e os testes de codigo tambem executavam. Reexecutado
  isoladamente com `--timeout 180000`, passou em 48,8 segundos, sem alterar
  suas assercoes. Todos os 21 cenarios passaram considerando essa repeticao;
  a primeira execucao completa teve codigo de saida diferente de zero.
- Capturas locais da memoria: `.local/ggf/engine-memory-desktop.png` e
  `.local/ggf/engine-memory-mobile.png`. Layout inspecionado nos dois tamanhos;
  dados exibidos sao exclusivamente simulados.

Nenhuma nova apuracao SAP foi executada nesta etapa: falta selecionar
explicitamente conta, percentual, criterio e OPs para o teste real. Os testes
automatizados do novo adaptador usam respostas inventadas e nao comprovam a
integracao em execucao. O diagnostico real anteriormente aprovado foi preservado.

## Arquivos desta etapa

- Motor: `engine/types.ts`, `engine/allocation.ts`, `engine/sourceEvidence.ts`.
- Fonte: `repository/SapGgfCalculationSource.ts` (novo), verificacao de referencias
  complementares em `repository/MappedGgfSource.ts`.
- Simulacao: `development/fixtures.ts`, `development/DevelopmentGgfRepository.ts`.
- Memoria/tela: `service/export.ts`, `controller/Closing.controller.ts`,
  `view/Allocations.fragment.xml`, `view/Closing.view.xml`, `i18n/i18n.properties`.
- Execucao: `scripts/ggf-sap-calculate.mjs` (novo), `package.json`.
- Testes novos: `test/ggf/rateioEngine.test.ts`, `test/ggf/sapCalculationSource.test.ts`,
  `test/browser/ggf-engine.spec.mjs`; adaptados `test/ggf/sourceEvidence.test.ts`,
  `test/browser/ggf.spec.mjs`, `test/browser/ggf-records.spec.mjs`.
- Documentacao: este arquivo, `GGF-SOURCE-CONTRACT.md`, `GGF-READ-MAPPING.md` e README.

Prefixos do primeiro grupo de caminhos: `webapp/modules/ggf/`.
Alteracoes locais anteriores preservadas. Nenhum arquivo de credenciais editado.
