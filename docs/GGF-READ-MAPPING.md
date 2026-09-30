# GGF: levantamento real da Service Layer

## Base ativa: SBODEMOBR2

**Primeira prova real executada:** [custo direto e quantidade com conferencia
independente](GGF-REAL-RATEIO-VALIDATION.md). Ambos conciliam matematicamente;
conta usada somente para validacao tecnica, nao aprovada como GGF funcional.

**Etapa de motor:** [quatro criterios, memoria e leitura de calculo restrita](GGF-RATEIO-ENGINE.md).
`SapGgfCalculationSource` permite validacao matematica com selecao explicita,
sem ampliar a auditoria ou escolher pool automaticamente. Custo atual e horas
ausentes continuam bloqueados para seus usos; nao impedem criterios independentes
com base comprovada. A previa de conferencia existente nao virou contabilizacao.

**Etapa seguinte executada:** [conferencia por OP](GGF-ORDER-BASIS-AUDIT.md).

**Diagnostico funcional complementar:** [custos ja absorvidos, recursos, contas do
periodo e bases disponiveis](GGF-FUNCTIONAL-DIAGNOSTIC.md). Reutiliza a auditoria
aprovada sem repeti-la; nenhuma conta/base oficial ou contabilizacao liberada.
OPs 76/77/79 (chaves 203/204/206), componentes, recebimentos e dez lancamentos
rastreados. Materiais + recursos conferem com os recebimentos neste conjunto;
nao ha apontamentos de setembro ligados a essas OPs. Unidades de dois recursos,
custo atual e politica de custo direto continuam pendentes. O custo atual e as
horas permanecem nulos, sem liberar rateio.

Troca autorizada pelo usuario e executada em 28/09/2026. `.env`, restricao de
empresa do transporte e identificacao da previa agora usam **SBODEMOBR2**.
O relatorio recebe a empresa da sessao autenticada, nao do mapeamento de campos.
Relatorios da empresa anterior sao rejeitados pelo assistente. As evidencias
anteriores foram preservadas em `.local/ggf/history/SBO_DEMO_ECOMMERCE-*/`.

Login, TLS estrito e metadata confirmados novamente: versao `1000340`, TLS 1.3,
certificado valido ate 30/09/2026 e catalogo com 569 entradas.

| Fonte | Contagem global confirmada |
| --- | ---: |
| ChartOfAccounts | 639 |
| JournalEntries | 1895 |
| ProductionOrders | 79 |
| InventoryGenEntries | 70 |
| InventoryGenExits | 33 |
| Resources | 8 |
| ResourceGroups | 1 |
| ProjectManagementTimeSheet | 7 |
| BusinessPlaces | 3 |
| UnitOfMeasurements | 8 |
| SQLQueries | 39 (catalogadas, nao executadas nem alteradas) |

Leitura reproduzida para **01/09/2026 a 30/09/2026**, todas as filiais/dimensoes:

- 67 lancamentos em quatro paginas, 497 linhas, 67 leituras individuais e
  countdistinct=67. Debitos e creditos: **96074.500000** cada, diferenca zero.
- Tres recebimentos (DocEntry 109, 110, 111), todos em 28/09/2026, cada um com
  uma linha com referencia BaseType=202 e BaseEntry preenchido. Nenhuma dessas
  tres linhas possui MeasureUnit ausente. Quatro documentos de saida no periodo.
- Totais dos recebimentos: 5500.580000, 108.840000 e 108.810000; diferenca contra
  debitos dos respectivos lancamentos (2255, 2259, 2262): zero em cada caso.
- As 79 OPs, os 8 recursos e as 7 folhas de apontamento sao inventarios globais,
  **nao** contagens de bases elegiveis no periodo. Amostras de recursos indicam
  unidade `horas`, ainda sem aprovacao de conversao/vinculo dos apontamentos.
- Nenhuma divergencia nos controles estruturais executados. Isso nao aprova
  contas participantes, custo direto/atual por OP, horas ou unidades equivalentes.
  O valor 96074.50 e movimento contabil de todas as contas, **nao GGF apurado**.

```sh
npm run ggf:sap:discover
npm run ggf:sap:read -- 2026-09-01 2026-09-30
```

A previa continua em
<http://localhost:8082/index.html?mode=development&source=sap-read#/ggf/fechamento>,
agora com setembro como periodo inicial. Evidencia atual em
`.local/ggf/read-report.json`; nenhuma evidencia da empresa anterior e reutilizada.
Contabilizacao e normalizacao para rateio continuam bloqueadas. Nao foram criados
dados, consultas ou metadados. A demonstracao ficticia continua separada.

## Historico: SBO_DEMO_ECOMMERCE em 28/09/2026

**Todo o restante deste documento registra o levantamento anterior. As contagens
e ausencias abaixo nao descrevem a SBODEMOBR2.** As protecoes e pendencias de
normalizacao continuam aplicaveis, exceto a ausencia de dados industriais.

Empresa autorizada: **SBO_DEMO_ECOMMERCE**. Conexao e leituras reais executadas
nesta maquina. **Mapeamento parcial de conferencia, nao um rateio SAP validado.**
Nao ha ordens de producao, recursos ou apontamentos nesta empresa nas leituras
efetuadas. Nao foi possivel produzir bases por OP, comparar custos por OP nem
executar uma distribuicao real. Nenhum dado foi criado para preencher essa lacuna.
Contabilizacao, reavaliacoes e instalacao de metadados nao foram executadas.

## Conectividade e seguranca

- TCP/HTTPS na porta configurada 50000: conectado em 28/09/2026, 11:00 UTC.
- TLS **ativo**, negociado em TLS 1.3, certificado aceito com verificacao estrita.
  Validade: 16/03/2026 a **30/09/2026 23:59:59 GMT**. Renovacao proxima necessaria.
  Nao foi necessario nem implementado fallback inseguro.
- Login aceito na empresa autorizada; versao retornada **1000340**, timeout de
  sessao 30 minutos. Esse numero nao foi convertido em uma designacao de patch.
- `/b1s/v2/$metadata`: HTTP 200, EDMX OData v4; catalogo: 452 entradas.
- `$select`, `$filter` por data, `$orderby`, `$count`, `Prefer: odata.maxpagesize=20`,
  `@odata.nextLink` relativo e `countdistinct` de `JdtNum` responderam nesta base.
- Credenciais permanecem apenas no `.env` local ignorado. Cookies ficam na memoria
  do processo Node, nunca no navegador, relatorios, testes ou capturas.
  `.local/` e ignorado; contem metadados e resultados locais, sem resposta de Login.
- Ferramentas expoem apenas GET para dados. Os unicos POST utilizados sao Login
  e Logout. Nenhuma consulta SQL foi instalada, nenhum objeto SAP foi alterado.
  Nao houve acesso ao projeto antigo.

## Fontes e contagens comprovadas

Contagens globais conferidas por `GET Entidade/$count` e colecoes. As entidades
vazias comprovam acesso e esquema, **nao comprovam semantica de dados ausentes**.

| Fonte real | Global | Junho/2026 na conferencia | Evidencia |
| --- | ---: | ---: | --- |
| ChartOfAccounts | 627 | 627 | 32 paginas de 20, ordenacao Code, controle 627 |
| JournalEntries | 51 | 49 | 3 paginas, 161 linhas, count=49, countdistinct=49, 49 leituras individuais |
| ProductionOrders | 0 | 0 (inventario global) | colecao vazia e count=0 |
| InventoryGenEntries | 2 | 2 | 72 linhas de recebimento, nenhuma ligada a OP |
| InventoryGenExits | 0 | 0 | colecao vazia e count=0 |
| Resources | 0 | 0 (inventario global) | colecao vazia e count=0 |
| ResourceGroups | 1 | 1 | cadastro, nao horas realizadas |
| ProjectManagementTimeSheet | 0 | 0 (inventario global) | colecao vazia e count=0 |
| BusinessPlaces | 4 | 4 | cadastro BPL, nao confundir com entidade Branches |
| UnitOfMeasurements | 1 | 1 | cadastro, nao uma regra de equivalencia entre produtos |
| SQLQueries | 0 | nao utilizada | catalogo vazio; nao criamos consultas |

Datas contabilizadas encontradas: 04, 05, 08, 17, 18, 23, 24/06 e 23/09/2026.
Junho foi usado para a conferencia por conter os dois recebimentos. **Nao e um
periodo aprovado de fechamento industrial.**

## Matriz de mapeamento

| Fonte / campos verificados no metadata | Datas, filial, dimensoes | Unidade / sinal | Controle e limite funcional |
| --- | --- | --- | --- |
| ChartOfAccounts: Code, Name, ActiveAccount, AccountType, AcctCurrency; Balance existe | Cadastro integral, sem data; BPLID, LoadingFactorCode e 2..5 | Balance e saldo acumulado, nao gasto do periodo | Code unico + count. Contas participantes nao escolhidas automaticamente por numero ou nome. |
| JournalEntries: JdtNum, ReferenceDate, OriginalJournal; JournalEntryLines: Line_ID, AccountCode, Debit, Credit, DebitSys, CreditSys, FCDebit, FCCredit, FCCurrency, BPLID, CostingCode e 2..5 | Filtro executado: ReferenceDate ge inicio e le fim; sem filtro de filial/dimensao. Campos de linha existem; semantica de competencia e estorno a aprovar | Conferencia usa Debit - Credit em moeda local, preserva seis casas; nao mistura moeda estrangeira/sistema; nao presume ISO a partir de R$ | Paginas + count + countdistinct + releitura por JdtNum com comparacao de IDs/valores/filial/dimensoes. Controle estrutural, nao razao independente do cliente SAP. |
| ProductionOrders: AbsoluteEntry, DocumentNumber, ItemNo, PostingDate, ReleaseDate, ClosingDate, CompletedQuantity, InventoryUOM, UoMEntry, ProductionOrderStatus; ProductionOrderLines | Inventario global, sem regra presumida de elegibilidade; DistributionRule e 2..5 existem | CompletedQuantity e acumulado da OP, nao quantidade produzida no periodo. Nao usado como denominador | count=0, nenhuma OP para conferir. Custo direto/atual total nao identificado como fonte valida. |
| InventoryGenEntries / InventoryGenExits: DocEntry, DocDate, DocCurrency, DocTotal, Cancelled, TransNum, BPL_IDAssignedToInvoice; DocumentLines: LineNum, BaseType, BaseEntry, BaseLine, Quantity, InventoryQuantity, MeasureUnit, UoMEntry, UoMCode, ItemType, CostingCode e 2..5, WarehouseCode, LineTotal, StockInmPrice | Filtro executado por DocDate, sem filial/dimensao; cancelados nao excluidos silenciosamente | Candidatos a movimentos por OP via BaseType/BaseEntry; entrada/saida, devolucao, desmontagem e cancelamento precisam de regra de sinal. LineTotal/DocTotal nao sao assumidos como custo de OP | count por documento; TransNum cruzado com lancamento lido. Neste conjunto todos BaseType=-1, BaseEntry=null. Nao ha exemplo de vinculo industrial comprovado. |
| Resources: Code, Group, UnitOfMeasure, Cost1..10; ResourceGroups: Code, NumOfUnitsText | Cadastros globais; sem horas de periodo | Unidade e tarifas cadastrais nao comprovam horas reais nem custo historico | Resources=0, grupos=1. Conversao de consumo de recurso em horas pendente. |
| ProjectManagementTimeSheet: AbsEntry, DateFrom, DateTo; linhas: Date, Workorder, EffectiveTime, Break, Branch, CostCenter | Inventario global de cabecalhos; campos das linhas apenas no metadata nesta base vazia | EffectiveTime e TimeOfDay; Workorder nao foi interpretado como OP industrial sem evidencia | count=0. Sem amostra para comprovar ligacao a OP/recurso/grupo. |
| BusinessPlaces BPLID/BPLName; UnitOfMeasurements AbsEntry/Code/Name | Cadastros globais | Identificadores e unidades nao equivalem a politica de escopo/normalizacao | count e chaves unicas. Filtros por filial/dimensao do assistente SAP ficam desabilitados nesta etapa. |

O conjunto de campos efetivamente projetados esta em `SapB1ReadMapping.ts`.
Campos adicionais acima foram constatados no metadata, nao usados para inventar
uma normalizacao. O candidato BaseType=202 nao teve amostra real nesta empresa;
nao ha conversao para quantidade produzida habilitada.

## Conferencia historica registrada

Node 24, dependencias instaladas, `.env` existente com origem HTTPS, empresa,
usuario/senha e `FBO_ENV=dev` ou `test`. Nao colocar valores secretos na linha
de comando. A verificacao TLS e obrigatoria mesmo se uma flag local pedir bypass.

O comando usado na captura anterior foi `npm run ggf:sap:read -- 2026-06-01
2026-06-30`. Nao o use para reproduzir os valores abaixo na base ativa: a empresa
mudou e a ferramenta agora rejeita a empresa anterior. Consulte os artefatos
arquivados em `.local/ggf/history/` para a evidencia historica.

Resultado real obtido em 28/09/2026:

| Conferencia | Resultado |
| --- | --- |
| Debitos / creditos, todas as contas de junho | 407294.340000 / 407294.340000 (moeda local SAP) |
| Diferenca debito - credito | 0.000000 |
| Colecao vs leitura individual | 49 documentos / 161 linhas; nenhuma divergencia nos campos comparados |
| Contagens das fontes vs controles antes/depois da releitura | Sem divergencias |
| Recebimento DocEntry=3, TransNum=2, 04/06 | Total 283500.000000; diferenca contra debitos do lancamento 0.000000 |
| Recebimento DocEntry=8, TransNum=48, 18/06 | Total 94500.000000; diferenca contra debitos do lancamento 0.000000 |
| Bases produtivas | Nenhuma OP, nenhum recurso, nenhum apontamento; nao calculadas |
| Lacuna de unidade | 11 linhas sem MeasureUnit em cada recebimento, 22 de 72 |

**407294.34 nao e GGF apurado.** E a soma de debitos de todas as contas do periodo,
inclusive contrapartidas, sem selecao funcional das contas participantes.
A igualdade DocTotal/debitos foi observada nesses dois documentos e nao e uma
formula geral de valorizacao do estoque. Nenhuma quantidade foi somada entre
itens heterogeneos. Nenhum saldo ausente virou zero presumido de base.

O arquivo `.local/ggf/read-report.json` inclui movimentos por conta com referencias
JdtNum/Line_ID, contagens, comparacoes e bloqueios. E recriado a cada execucao;
falha remove o resultado anterior e nao publica parcial. Metadados, catalogo,
survey e inspection locais sao evidencias de captura, nao fixtures de producao.

## Previa no assistente

```sh
npm start -- --port 8081
# Em outro terminal:
npm run ggf:sap:preview
```

Abra <http://localhost:8082/index.html?mode=development&source=sap-read#/ggf/fechamento>.
Clique **Conferir fontes SAP** na etapa 1. O backend local abre uma sessao efemera,
executa GETs, encerra a sessao e entrega somente o relatorio. Sem credenciais,
cookies SAP, host SAP ou proxy arbitrario no navegador. O listener e 127.0.0.1,
verifica Host/origem/cabecalho de opt-in, rejeita metodos de escrita e serializa
as leituras. Nao e um backend para publicacao na rede ou producao.

A demonstracao continua separada em
<http://localhost:8081/index.html?mode=development#/ggf/fechamento>.
Nao existe fallback de SAP para fixtures. No modo SAP nao se carrega a configuracao
ficticia do localStorage; Classificacao/Rateios ficam indisponiveis nesse modo,
e os quatro criterios originais permanecem intactos na demonstracao.

## Limites e proximos passos

`MappedGgfSource.inspectSources()` reutiliza os controles de pagina, ciclo,
IDs unicos, nextLink e contagem, mas **nao retorna SourceSnapshot**. O mapeamento
SAP fornece somente as fontes comprovadas; falta `currentCosts`, e
`loadSnapshot()` rejeita esse mapeamento incompleto. `normalize()` tambem bloqueia
explicitamente. Nenhuma evidencia de custo, hora ou comparabilidade e fabricada.

Pendencias para habilitar os quatro criterios com dados reais:

1. Preparar dados industriais nesta empresa ou obter autorizacao explicita para
   outra base. Nao houve mudanca de empresa nem criacao de dados.
2. Aprovar contas/classificacoes, periodo, competencia, filial, dimensoes,
   exclusao de gastos ja absorvidos, estornos/cancelamentos e elegibilidade de OPs.
3. Comprovar recebimentos/consumos por OP, unidades equivalentes por produto,
   horas efetivas e grupos; separar tarifa atual de custo efetivamente incorrido.
4. Identificar custo atual **total da OP** e seus componentes, estoque/CPV,
   moeda ISO e precisao; implementar normalizacao versionada com origem por linha.
5. Conferir contra relatorio/razao e bases do SAP de forma funcional independente.
   count e countdistinct consultam a mesma base; releitura por chave nao elimina
   mudancas concorrentes com contagem constante. Nao ha snapshot transacional.
6. Somente depois habilitar `ClosingSession.calculate` real. Regra contabil e
   qualquer escrita continuam uma etapa separada, com confirmacao bloqueada.

Testes novos usam respostas **inventadas e identificadas**, nunca credenciais ou
extratos reais. Cobrem mapeamento parcial, precisao, contagem, detalhe, deriva,
escopo nao aprovado, seguranca do transporte e separacao dos modos no navegador.
Empacotamento e entrada Web Client nao foram alterados nesta etapa; o gateway
local nao integra o pacote. Sessao do host, origem/CSP, permissoes e comportamento
embarcado ainda precisam ser verificados com a extensao instalada.

Referencia de protocolo, nao prova de mapeamento desta empresa:
[SAP Service Layer API Reference](https://help.sap.com/doc/056f69366b5345a386bb8149f1700c19/10.0/en-US/Service%20Layer%20API%20Reference.html).
