# Conferencia das bases por OP - SBODEMOBR2

Leitura real em **28/09/2026**, selecionando OPs referenciadas por recebimentos
de **01/09/2026 a 30/09/2026**. Todas as filiais/dimensoes; sem escrita de negocio,
sem alteracao de cadastro, sem SQLQueries e sem contabilizacao.

**Resultado: valores e vinculos dos movimentos conferidos; bases normalizadas
do GGF ainda nao aprovadas.** O relatorio mantem `currentCost` e `actualHours`
como `null`, nunca como zero presumido. Nao alimenta um `SourceSnapshot` de rateio.

## Ordens conferidas

| OP (DocumentNumber) | Chave (AbsoluteEntry) | Item | Recebido no periodo | Unidade | Materiais: LineTotal das saidas | Recursos: LineTotal das saidas | LineTotal recebido | Diferenca componentes - recebimento |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 76 | 203 | C00003 | 1 | UN | 1000.58 | 4500.00 | 5500.58 | 0.00 |
| 77 | 204 | z202604 | 1 | UN | 91.84 | 17.00 | 108.84 | 0.00 |
| 79 | 206 | z202604 | 1 | UN | 91.81 | 17.00 | 108.81 | 0.00 |

Os valores sao os campos monetarios observados nos documentos, cuja moeda e
`R$`. Nao representam aprovacao de moeda ISO, politica de custo direto nem custo
atual para reavaliacao. A aritmetica da conferencia usa inteiros com seis casas,
sem arredondar esses valores para forcar igualdade.

As tres ordens sao `bopotStandard` e `boposClosed`, com quantidade concluida 1,
rejeitada 0 e encerramento em 28/09/2026. Os recebimentos acumulados encontrados
conferem com `CompletedQuantity`; as quantidades baixadas por componente conferem
com `IssuedQuantity`. Os movimentos vinculados encontrados ocorreram em setembro,
mas a coleta buscou **todas as datas** para nao comparar acumulado com recorte mensal.

## Trilha documental

| OP | Recebimento / linha | Saidas / linhas | Lancamentos das movimentacoes | Lancamento referenciado no encerramento |
| --- | --- | --- | --- | --- |
| 76 | InventoryGenEntries(109)/0 | InventoryGenExits(77)/0..11 e (78)/0 | 2255, 2254, 2256 | 2257 |
| 77 | InventoryGenEntries(110)/0 | InventoryGenExits(79)/0..4 | 2259, 2258 | 2260 |
| 79 | InventoryGenEntries(111)/0 | InventoryGenExits(80)/0..4 | 2262, 2261 | 2263 |

- Nas entradas: `BaseType=202`, `BaseEntry=AbsoluteEntry`, item pai e
  `TransactionType=botrntComplete`. `BaseLine` e nulo nos recebimentos deste caso.
- Nas saidas: `BaseEntry` identifica a OP; `BaseLine` confere com
  `ProductionOrderLines.LineNumber`, e item/tipo conferem com o componente.
- `TransNum` confere com `JournalEntries.JdtNum`; `Original` e `OriginalJournal`
  conferem com documento e tipo de origem. Encerramentos usam a referencia
  `ProductionOrders.TransactionNumber`, conferida contra a origem da OP.
- Os sete documentos estao com `Cancelled=tNO` e `CancelStatus=csNo`.
  Soma de `LineTotal`, total do documento e debitos do respectivo lancamento
  conferem nestes documentos. Isso nao e uma formula generica para qualquer
  documento, moeda, tributo ou esquema contabil.

## Horas: consumo nao e apontamento

| OP | Recurso | Quantidade baixada | Unidade no documento / cadastro | Metodo | Grupo |
| --- | --- | ---: | --- | --- | --- |
| 76 | R300007 | 1 | horas / horas | im_Backflush | 1 |
| 77 e 79, em cada OP | R300010 | 1 | ausente / ausente | im_Backflush | 1 |
| 77 e 79, em cada OP | R300011 | 1 | ausente / ausente | im_Backflush | 1 |

Foram lidas sete folhas, com oito linhas. **Nenhuma linha tem data de setembro**;
nenhuma referencia as OPs 76/77/79, nem suas chaves 203/204/206. Isso comprova
ausencia de linhas nesse conjunto lido, nao ausencia real de trabalho executado.

A unica linha com `Workorder` preenchido e a folha 28/linha 1, de 22/06/2026:
`Workorder=62`, `EffectiveTime=10:00:00`. O valor encontra `DocumentNumber=62`,
cuja chave e 178; nao existe `AbsoluteEntry=62` no conjunto. Nao foi incorporada
ao periodo nem atribuida as OPs auditadas. O relatorio conserva candidatos por
numero e por chave, sem generalizar a semantica a partir de uma unica amostra.

`UnitsPerTime` e `TimePerUnits` foram registrados, nao convertidos em horas reais.
Nos recursos R300010/R300011 aparecem respectivamente 30 e 15, com
`UnitsPerTime=1`. A SAP descreve esses parametros como conversao de capacidade
e calculo de tempo de execucao, nao como registro de duracao efetivamente
apontada. [Cadastro de recursos SAP](https://help.sap.com/docs/SAP_BUSINESS_ONE/f19b844f41b74a8c8ca26f4d501e032b/9862f0b3e7f74e9bb04af71685654f6a.html?locale=en-US&state=PRODUCTION&version=10.0).

Consequencia: **Horas apontadas e Grupo de recurso continuam sem base temporal
aprovada**. Nem 1 unidade baixada vira automaticamente 1 hora, nem tempo de
capacidade substitui apontamento. As baixas automaticas nao foram apresentadas
como medicoes de tempo. Os percentuais de grupo tambem nao foram presumidos.

## Custos: o que foi e nao foi demonstrado

A SAP distingue componentes de item, recursos, adicionais e produto recebido,
com tratamentos de devolucao e variancia. Isso orienta a conferencia, mas nao
prova que um campo isolado da Service Layer seja o custo atual exigido pelo GGF.
[Resumo de custos da OP](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727/44f292ebdf7365fbe10000000a1553f7.html?locale=enUS).

1. **Composicao monetaria rastreavel:** os valores de materiais e recursos acima
   vieram das linhas das saidas, sem multiplicar tarifas atuais do cadastro.
   Conferem com o valor dos recebimentos neste conjunto. Ainda falta aprovar quais
   componentes entram no criterio de custo direto e como tratar outros casos.
2. **Encerramento nao e custo adicional:** os totais de debito dos encerramentos
   sao 9000.00, 125.84 e 125.81, respectivamente. Eles incluem contrapartidas;
   nao foram somados aos recebimentos nem usados como custo atual das OPs.
3. **Contas requerem revisao funcional:** os recursos movimentam
   `4.01.01.04.07` (Despesas Assessoria e Consultoria), inclusive com debito e
   credito na mesma conta nas saidas. Nos recebimentos 110/111, a contrapartida
   de debito e `5.03.01.01.01` (Variacao do Custo Medio), enquanto o 109 debita
   `1.01.02.01.01` (Mercadorias para Revenda). O credito dos recebimentos e em
   `1.01.02.01.03` (Produtos em Elaboracao). Isso e um fato observado, nao uma
   conclusao de erro contabil. Nao alteramos a determinacao de contas.
4. **Risco de dupla absorcao:** se contas ja usadas no custo dos recursos forem
   escolhidas como GGF, sera preciso definir exclusoes/competencia. Nenhuma conta
   foi escolhida automaticamente como participante.
5. **Nao usar preco medio do cadastro como custo da OP:** `Items.MovingAveragePrice`
   retornou 174.66 para C00003 e 0 para z202604; isso nao corresponde aos valores
   recebidos por OP. `StockInmPrice` nas linhas lidas tambem nao serve como
   substituto: retornou zero, apesar dos valores efetivos dos documentos.
6. **Mesma unidade nao prova equivalencia:** OP 76 produz C00003 e OPs 77/79
   produzem z202604. Todas dizem UN, mas nao foi aprovada equivalencia entre
   esses produtos para rateio por quantidade.

As OPs 77 e 79 tem a mesma estrutura consultada, mas os valores de materiais
diferem em 0.03. A diferenca aparece nas linhas de origem, nao no motor GGF.
A causa dessa variacao de valorizacao nao foi presumida.

## Coleta e limitacoes

`SapB1OrderAudit.ts` reutiliza a coleta paginada de `MappedGgfSource` e a definicao
de leitura ja existente. Coleta global: 70 entradas, 33 saidas, 79 OPs, oito
recursos, um grupo e sete folhas, em 13 paginas. Contagens via `$count` conferidas
apos cada coleta e novamente ao final. Os dados das sete movimentacoes e tres
OPs escolhidas sao comparados integralmente com suas leituras individuais.

Lancamentos, itens e contas sao lidos por chaves referenciadas e tem a identidade
conferida. As linhas aninhadas usam IDs unicos; caminhos, campos, escopo e
controles sao registrados na evidencia local. O filtro do periodo seleciona OPs
a partir dos recebimentos; as leituras globais sao identificadas como globais,
nao como supostamente filtradas por data.

Limites: `$count` e releitura sao controles estruturais da mesma fonte, nao uma
segunda contabilidade. Nao ha snapshot transacional. Campos podem mudar apos a
releitura. Nao foram levantadas todas as reavaliacoes, transferencias,
vendas/consumos posteriores ou a valorizacao de estoque remanescente por OP.
Nao foi conferida a tela Resumo/Lista de lancamentos de estoque no cliente SAP.

Em cancelamentos, devolucoes, desmontagem, unidade/moeda incompativel ou vinculo
de componente inconsistente, o diagnostico sinaliza a pendencia e nao presume
totais conciliados. Falha de pagina, contagem, identidade ou releitura interrompe
a coleta. Continuacao de paginacao em colecoes aninhadas tambem bloqueia a leitura
ate existir mapeamento explicito. Dado ausente ou precisao nao suportada nao vira zero.

## Reproduzir e conferir no SAP

```sh
npm run ggf:sap:orders -- 2026-09-01 2026-09-30
```

Saidas ignoradas pelo Git, sem credenciais:

- `.local/ggf/order-audit-source.json`: projecoes originais, consultas e evidencias.
- `.local/ggf/order-audit-report.json`: comparacoes, referencias e pendencias.

O script remove os resultados anteriores antes de iniciar. Nao faz fallback para
fixtures. Se a analise falhar, pode permanecer a captura bruta completa para
diagnostico, mas nao um novo relatorio de comparacoes. Nao altera o assistente,
seus quatro criterios, memoria, CSV nem o bloqueio de contabilizacao.

Para uma conferencia funcional independente, abrir no cliente SAP as OPs
**76, 77 e 79**, consultar o Resumo e os documentos referenciados na tabela;
comparar componentes, recursos, produto e variancia. Conferir a determinacao de
contas e o significado de custo atual antes de qualquer reavaliacao.

Proxima decisao: contas/classificacoes/criterios, escopo de custo direto,
equivalencia de quantidades, origem real das horas e definicao de custo atual.
Os quatro criterios nao estao liberados para dados reais apenas por estas somas
terem conciliado.

## Verificacoes executadas

- `npm test`: 277 testes aprovados em 22 arquivos, incluindo 19 da auditoria de OPs.
- `npm run typecheck`: aprovado.
- `npm run build:module`: aprovado; empacotamento existente preservado.
- `npm run ggf:sap:orders -- 2026-09-01 2026-09-30`: executado contra
  SBODEMOBR2, sem diferencas nos controles estruturais e nas comparacoes numericas
  descritas acima. Pendencias funcionais continuam bloqueantes.
- `.env` e os dois artefatos locais de auditoria confirmados como ignorados pelo Git.

Nao houve alteracao de tela nesta etapa; os testes de navegador nao foram
reexecutados. A auditoria nova e um comando local e um relatorio, nao uma nova
tela do assistente. Contabilizacao permanece bloqueada.

## Arquivos da etapa

- `webapp/modules/ggf/repository/SapB1OrderAudit.ts` (novo).
- `webapp/modules/ggf/repository/SapB1ReadMapping.ts` (exportacao do definidor de leitura).
- `scripts/ggf-sap-order-audit.mjs` (novo) e `package.json` (comando local).
- `test/ggf/orderAudit.test.ts` (fixtures inventadas; sem extratos reais).
- Este documento, `docs/GGF-READ-MAPPING.md` e `README.md`.

Alteracoes anteriores preservadas. Nenhuma credencial foi copiada para codigo,
testes, documentacao ou saida do comando.
