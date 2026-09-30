# GGF V2 - Conciliação de absorção

## Escopo da Fase 1

Esta é uma área experimental paralela ao fluxo GGF V1. O assistente, os quatro critérios de rateio, ClosingId, versões, PostingHash, claims, integridade, FIFO e prévia de MaterialRevaluation não foram substituídos. A V2 lê dados, calcula a conciliação e não grava no SAP. Não há lançamento, reavaliação, alteração de custo, estoque, OP ou recurso nesta fase.

Fluxo da Fase 1:

`real contábil por categoria - custo padrão absorvido configurado = diferença de absorção`

A diferença é representada pelo contrato `AbsorptionDifference` e pode ser adaptada ao formato de saldo consumido pelo motor V1. A matemática do motor `allocate()` não foi alterada. O adaptador é uma entrada técnica; ainda não cria uma regra para ratear/contabilizar diferenças.

## Configuração explícita

Na rota **GGF V2 / Apuração**, acessível pelo botão no assistente V1 em modo de desenvolvimento, o usuário informa um JSON local contendo:

```json
{
  "accounts": [{ "account": "<código SAP>", "category": "MOD|GGF" }],
  "resources": [{ "resource": "<código SAP>", "component": 1, "category": "MOD|GGF" }],
  "technicalHomologation": true
}
```

O JSON é guardado somente no `localStorage` deste navegador. Não existe classificação inicial ou inferência por descrição. A API local aceita somente GET, exige opt-in same-origin, valida a empresa SBODEMOBR2 e não repassa ao SAP qualquer POST/PATCH. `technicalHomologation` é obrigatório nesta tela para impedir que uma classificação de demonstração seja apresentada como funcional.

## Contrato de leitura SAP

| Fonte | Campos lidos | Escopo e uso |
| --- | --- | --- |
| `JournalEntries` | `JdtNum`, `ReferenceDate`, `OriginalJournal`, `Original`, `BaseReference`, `TransactionCode`, `JournalEntryLines` | `ReferenceDate` entre as datas escolhidas. Em linhas: `Line_ID`, `AccountCode`, `Debit`, `Credit`, `BPLID`, `CostingCode` a `CostingCode5`. Aplica conta selecionada, filial e cada dimensão sobre a linha. Sinal real = débito - crédito. `$count` confere a quantidade de cabeçalhos da coleção. |
| `ChartOfAccounts` | `Code`, `Name` | Leitura pontual por conta explicitamente configurada e conferência independente via `$count`. |
| `InventoryGenExits` / `InventoryGenEntries` | `DocEntry`, `DocNum`, `DocDate`, `Cancelled`, `CancelStatus`, `TransNum`, `DocumentLines` | `DocDate` no período; linhas somente `ItemType=dit_Resource`, `BaseType=202`, ligadas a OP. Saída é absorção positiva; entrada/retorno é negativa. `$count` confere cabeçalhos. Movimentos são diagnosticados também quando ainda não há mapeamento. |
| `ProductionOrders` | `AbsoluteEntry`, `DocumentNumber`, `ItemNo`, `InventoryUOM`, `PlannedQuantity`, `CompletedQuantity` | GET pontual para cada `BaseEntry` de OP observado nos movimentos de recurso; identidade conferida pelo `AbsoluteEntry`. |
| `Items` | `ItemCode`, `ItemName` | GET pontual para o item produzido da OP; identidade conferida pelo `ItemCode`. |
| `Resources` | `Code`, `Name`, `Type`, `UnitOfMeasure`, `Cost1` a `Cost10` | GET pontual para cada recurso encontrado nas linhas do período; identidade conferida pelo `Code`. Todas as tarifas são preservadas para diagnóstico, mas só componentes explicitamente mapeados participam do cálculo. |

A quantidade de cabeçalhos é reconciliada com `$count`; leituras pontuais conferem as chaves solicitadas. Os campos de linhas contábeis e de movimentos vêm embutidos no respectivo cabeçalho. A Service Layer não fornece neste fluxo um controle independente de contagem das linhas embutidas; por isso o relatório não declara snapshot transacional ou completude funcional. O mês de setembro ainda está aberto e uma nova execução pode apresentar saldos diferentes.

Filial e cinco dimensões filtram lançamentos contábeis (`BPLID`, `CostingCode`...`CostingCode5`). Os documentos de estoque são filtrados por data; não se presume que dimensões do documento e da respectiva linha contábil sejam intercambiáveis. A tela não preenche filial/dimensões automaticamente.

## Regras matemáticas

Por conta mapeada, débito e crédito são totalizados sem perder sinal. Por componente configurado, o montante padrão é:

`quantidade assinada da linha de movimento × custo unitário CostN atual`

Saídas consomem positivamente; devoluções são negativas. O produto é arredondado por linha ao centavo mais próximo, meio centavo para longe de zero. Unidades devem existir e coincidir entre a linha de movimento e `Resources.UnitOfMeasure`; caso contrário a linha não compõe custo padrão. Recursos sem componente ou com CostN não zero ainda não classificado também bloqueiam a conciliação completa. `DocumentLines.LineTotal` é exibido como evidência contábil do movimento, não substitui CostN e não é somado novamente à absorção padrão.

`diferença = real contábil (débito - crédito) - padrão absorvido`

Diferença zero = conciliado; positiva = subabsorção; negativa = sobreabsorção. Saldos negativos são mantidos, não convertidos em valores absolutos.

## Prova técnica real

Execução somente de leitura em `SBODEMOBR2`, período `2026-09-01` a `2026-09-30`, captura `2026-09-30T15:23:26Z` (UTC), versão Service Layer `1000340`. Configuração exclusivamente técnica, não aprovada funcionalmente:

- Conta `4.01.01.04.07`, descrição SAP `Despesas Assessoria e Consultoria`, atribuída explicitamente à categoria GGF somente para exercitar o cálculo.
- Recurso `R300007`, componentes `Cost1` como MOD e `Cost2` como GGF somente para exercitar o cálculo.
- Nenhum percentual ou conta oficial de GGF foi inferido. Essa conta já apresenta risco de dupla absorção e não deve ser promovida a pool oficial.

| Categoria | Real débito | Real crédito | Real líquido | Padrão absorvido | Diferença | Diagnóstico |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| MOD | R$ 0,00 | R$ 0,00 | R$ 0,00 | R$ 3.000,00 | -R$ 3.000,00 | Sobreabsorção técnica |
| GGF | R$ 6.683,00 | R$ 11.349,00 | -R$ 4.666,00 | R$ 1.500,00 | -R$ 6.166,00 | Sobreabsorção técnica |

A conta teve 21 linhas selecionadas; exemplos incluem `TransId 2254`, 2257, 2258, 2260, 2261, 2263, 2264, 2266, 2269, 2274, 2277, 2283 e 2285, todas nas datas 28 ou 29/09. Os campos contábeis foram `JournalEntries.JdtNum`, `ReferenceDate`, `JournalEntryLines.Line_ID`, `AccountCode`, `Debit`, `Credit`, `BPLID` e dimensões 1-5. As 21 linhas tinham `BPLID=1` e dimensões vazias na leitura sem filtro.

A absorção configurada veio de `InventoryGenExits` DocEntry 77 / DocNum 30, linha 0, em 28/09, OP DocEntry 203 / número 76, item `C00003` (`Quadcore CPU 3.4 GHz`). A linha tinha quantidade 1 hora e `LineTotal=R$ 4.500,00`. `Resources('R300007')` retornou unidade `horas`, `Cost1=R$ 3.000,00` e `Cost2=R$ 1.500,00`. São tarifas do cadastro atual; não foi comprovado que eram os custos vigentes em setembro.

As 90 entradas de `JournalEntries`, 1 conta selecionada, 11 `InventoryGenExits`, 10 `InventoryGenEntries` e 4 cadastros de recursos usados no período reconciliaram com `$count` ou com as chaves pontuais, conforme apropriado. A leitura observou movimentos de recursos nas OPs 76-83; não atribuiu todo o saldo contábil a uma OP.

Os demais recursos do período foram mantidos fora do montante calculado quando não estavam configurados. Evidência atual dos cadastros:

| Recurso | Tipo | Unidade | CostN atual não zero | Bloqueio |
| --- | --- | --- | --- | --- |
| R300007 Hora de Montagem Técnico | Labor | horas | Cost1 R$ 3.000,00; Cost2 R$ 1.500,00 | Tarifa histórica indisponível |
| R300010 Separador de Materia Prima | Labor | não informada | Cost1 R$ 5,00 | Unidade não comprovada e sem componente classificado |
| R300011 Empilhadeira | Máquina | não informada | Cost1 R$ 12,00 | Unidade não comprovada e sem componente classificado |
| R300006 Hora de Montagem Técnico Senior | Labor | horas | Cost1 R$ 500,00 | Sem componente classificado |

O saldo líquido difere em R$ 132,00 do diagnóstico anterior (-R$ 4.534,00). A nova consulta incluiu 90 cabeçalhos e ocorreu depois das leituras anteriores; como setembro está aberto, não se atribui causa sem comparar as versões detalhadas das fontes.

### Conferência independente

`scripts/ggf-v2-absorption-live.mjs` calcula débitos menos créditos e, em rotina separada, refaz quantidade × tarifa por categoria; ele não chama o motor de rateio. Para MOD e GGF, ambos os métodos coincidiram em real, absorvido e diferença, em centavos inteiros (R$ 0,00 de divergência matemática). Isso comprova a execução aritmética e a reprodução da leitura selecionada, não a classificação, a adequação funcional de `CostN`, o custo histórico ou uma regra contábil.

O JSON e o CSV reais ficam em `.local/ggf/` e são ignorados pelo Git; esses arquivos não contêm credenciais, cookies ou tokens. Para reproduzir, mantenha credenciais em `.env` ignorado e rode:

```sh
node scripts/ggf-v2-absorption-live.mjs
```

O pedido técnico usado está em `.local/ggf/v2-absorption-technical.json`; ele não é uma configuração funcional nem está versionado.

## Bloqueios e decisões pendentes

- Definir com controladoria quais contas e componentes formam MOD e GGF; os dados SAP não determinam classificação econômica.
- Obter tarifas padrão históricas por período. `Resources.Cost1..Cost10` lido hoje não prova a tarifa aplicada a movimentos de setembro.
- Definir componente, unidade e comportamento contábil dos recursos R300010 e R300011; a unidade SAP retornou vazia.
- Investigar o recurso R300006 e demais recursos sem componente classificado. Não usar descrição/tipo para inferir MOD/GGF.
- Determinar moeda e semântica de cada CostN e reconciliação do cadastro de custo padrão à contabilidade.
- Investigar a conta de validação, que contém linhas de consumo/estorno relacionadas à produção e pode gerar dupla absorção.
- Fazer a leitura de mês fechado e definir filtros de filial/dimensões com a regra contábil aprovada.
- Decidir distribuição de diferenças por conta e categoria usando o motor V1, sem criar lançamentos ou reavaliação nesta fase.

## Testes e limites

Cobertura nova inclui sinal contábil, sobreabsorção, subabsorção, saldo zero/negativo, classificação explícita, recurso sem configuração/unidade, arredondamento e fonte de leitura com datas, contagens, OP/item e identidade. A integração UI5 é somente de leitura; a V1 mantém sua tela e seus bloqueios. `MaterialRevaluation`, CPV, estoque versus consumido e contabilização V2 não fazem parte da Fase 1.
