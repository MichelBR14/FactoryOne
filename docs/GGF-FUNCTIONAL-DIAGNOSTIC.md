# GGF - diagnostico funcional em leitura

## Escopo e conclusao

Empresa **SBODEMOBR2**. Periodo selecionado: **01/09/2026 a 30/09/2026**.
Conjunto inicial: OPs **76, 77 e 79** (chaves 203, 204 e 206).
Diagnostico complementar capturado em **28/09/2026, 14:08:39 UTC**.
Setembro ainda esta em curso: isto nao certifica o encerramento do mes nem
inclui lancamentos que venham a ser registrados depois da captura.

A [auditoria tecnica aprovada](GGF-ORDER-BASIS-AUDIT.md) foi **reutilizada, nao
refeita**. Nao foram consultadas novamente OPs, entradas, saidas ou folhas de
horas. A composicao historica abaixo usa aquela captura; cadastros de recursos,
grupos, pesos e detalhamento contabil sao leituras complementares identificadas.

Conclusoes principais:

- Materiais consumidos: **1.184,23**. Recursos consumidos: **4.534,00**.
  Valor dos recebimentos: **5.718,23**. Esses valores nao sao um pool GGF.
- A parte de recursos ja participa do valor dos recebimentos. Sua natureza
  economica detalhada continua desconhecida: os nomes de componentes sao genericos.
- A conta de recursos 4.01.01.04.07 tem **saldo credor de 4.534,00** no periodo,
  originado exclusivamente nas saidas/fechamentos dessas OPs. Nao e evidencia
  de um novo gasto industrial positivo ainda nao absorvido.
- Existem contas do grupo "CUSTOS INDIRETOS APLICADOS NA PRODUCAO", mas **sem
  linhas contabeis no periodo capturado**. Nao encontramos nelas gasto a distribuir.
- Nao ha apontamentos de horas em setembro na auditoria aprovada. Quantidade
  consumida de recurso e capacidade parametrizada nao viram horas reais.
- Nenhuma conta, base, percentual ou regra oficial foi escolhida. Nao foi feito
  rateio. `allocationReady=false` e `postingBlocked=true` permanecem explicitos.

Valores em moeda local: documentos retornam `DocCurrency=R$`; razao usa
`Debit`/`Credit`, nao moeda estrangeira ou de sistema. Tabelas monetarias exibem
duas casas porque os valores desta amostra sao exatos nessa escala; o resumo
local soma com inteiros em seis casas, sem arredondar as linhas.
Saldo liquido significa **debito menos credito**, nao saldo acumulado da conta.

## 1. Composicao do custo ja absorvido pelas OPs

"Custo direto observado" nesta secao significa os materiais e recursos
documentados contra a OP. Nao certifica que todo componente de recurso seja
economicamente direto nem que seu valor nao contenha custos indiretos embutidos.
"Absorvido" e o valor historico observado no recebimento, **nao o custo atual
do estoque remanescente**, nem autorizacao para capitalizar novo GGF.

### Resumo por ordem

| OP / AbsoluteEntry | Item produzido | Planejada | Concluida | Recebida | Materiais | Recursos | Total absorvido no recebimento | Custo unitario historico resultante |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 76 / 203 | C00003 - Quadcore CPU 3.4 GHz | 1 UN | 1 UN | 1 UN | 1.000,58 | 4.500,00 | 5.500,58 | 5.500,58 / UN |
| 77 / 204 | z202604 - Carcaca do Estator | 1 UN | 1 UN | 1 UN | 91,84 | 17,00 | 108,84 | 108,84 / UN |
| 79 / 206 | z202604 - Carcaca do Estator | 1 UN | 1 UN | 1 UN | 91,81 | 17,00 | 108,81 | 108,81 / UN |
| Soma monetaria | Produtos diferentes | - | - | - | **1.184,23** | **4.534,00** | **5.718,23** | Nao somar custos unitarios |

O custo unitario foi derivado de `sum(DocumentLines.LineTotal)` dos recebimentos
dividido por sua quantidade recebida (1 em cada OP), e confere com `UnitPrice`
dessas linhas. Nao foi reconstruido a partir do preco medio do cadastro.
Materiais + recursos menos recebimentos = 0,00 em cada OP. A diferenca de 0,03
entre OPs 77/79 esta nos materiais da origem, nao num arredondamento GGF.

### Materiais consumidos

Todas as linhas abaixo sao `InventoryGenExits.DocumentLines`, `ItemType=dit_Item`,
`BaseType=202`. Quantidade = `Quantity`; unidade = `MeasureUnit`; valor unitario
= `UnitPrice` (igual a `Price` nesta captura); total = `LineTotal`.
`BaseEntry` e a chave da OP; `BaseLine` liga a `ProductionOrderLines.LineNumber`.

| OP | Material / ItemCode | Descricao da linha | Qtd | Un. | Valor unitario | Total | Saida DocEntry / LineNum | BaseLine |
|---|---|---|---:|---|---:|---:|---|---:|
| 76 | A00001 | Notebook Core i7 32gb Ram 2TB Ssd M2 | 1 | UN | 198,20 | 198,20 | 77 / 1 | 2 |
| 76 | A00005 | Wireless Router Wifi AC Extensor | 1 | UN | 39,39 | 39,39 | 77 / 2 | 3 |
| 76 | C00005 | WLAN Card | 1 | UN | 34,92 | 34,92 | 77 / 3 | 4 |
| 76 | C00006 | Gigabit Network Card | 1 | UN | 32,83 | 32,83 | 77 / 4 | 5 |
| 76 | C00007 | Hard Disk 3TB | 1 | UN | 148,40 | 148,40 | 77 / 5 | 6 |
| 76 | C00008 | Computer Monitor 24 polegadas HDMI | 1 | UN | 336,11 | 336,11 | 77 / 6 | 7 |
| 76 | C00009 | Keyboard Comfort USB | 1 | UN | 44,52 | 44,52 | 77 / 7 | 8 |
| 76 | C00010 | Mouse USB | 1 | UN | 34,48 | 34,48 | 77 / 8 | 9 |
| 76 | C00011 | Memoria DDR RAM 8GB | 1 | UN | 68,24 | 68,24 | 77 / 9 | 10 |
| 76 | C00012 | Gabinete para HD externo | 1 | UN | 14,00 | 14,00 | 77 / 10 | 11 |
| 76 | C00013 | Disco 1 TB para HD externo | 1 | UN | 35,78 | 35,78 | 77 / 11 | 12 |
| 76 | E00002 | MotherBoard | 1 | UN | 13,71 | 13,71 | 78 / 0 | 13 |
| 77 | z202611 | Aluminio | 1 | KG | 19,73 | 19,73 | 79 / 2 | 2 |
| 77 | z202613 | Forma da Carcaca | 1 | UN | 39,23 | 39,23 | 79 / 3 | 3 |
| 77 | z202615 | Areia Verde | 1 | KG | 32,88 | 32,88 | 79 / 4 | 4 |
| 79 | z202611 | Aluminio | 1 | KG | 19,72 | 19,72 | 80 / 2 | 2 |
| 79 | z202613 | Forma da Carcaca | 1 | UN | 39,22 | 39,22 | 80 / 3 | 3 |
| 79 | z202615 | Areia Verde | 1 | KG | 32,87 | 32,87 | 80 / 4 | 4 |

Descricoes acima sao apresentadas sem acentos por convencao deste documento;
os textos originais, inclusive caracteres especiais, estao na captura local.

### Recursos consumidos

Mesma entidade e campos de valor/quantidade, mas `ItemType=dit_Resource`.
O custo unitario **historico da linha** nao e substituido pelo cadastro atual.

| OP | Recurso | Quantidade | Unidade na linha | UnitPrice historico | LineTotal | Saida DocEntry / LineNum | BaseLine |
|---|---|---:|---|---:|---:|---|---:|
| 76 | R300007 | 1 | horas | 4.500,00 | 4.500,00 | 77 / 0 | 1 |
| 77 | R300010 | 1 | null | 5,00 | 5,00 | 79 / 0 | 0 |
| 77 | R300011 | 1 | null | 12,00 | 12,00 | 79 / 1 | 1 |
| 79 | R300010 | 1 | null | 5,00 | 5,00 | 80 / 0 | 0 |
| 79 | R300011 | 1 | null | 12,00 | 12,00 | 80 / 1 | 1 |

Todos esses componentes nas OPs usam `ProductionOrderIssueType=im_Backflush`.
O componente E00002 da OP76 e manual; os demais materiais sao backflush.
Backflush comprova consumo registrado, nao uma medicao de tempo trabalhado.

### Recebimentos, documentos e campos de origem

| OP | Entidade / DocEntry / LineNum | DocNum | TransNum (JdtNum) | Quantidade / unidade | LineTotal |
|---|---|---:|---:|---|---:|
| 76 | InventoryGenEntries / 109 / 0 | 68 | 2255 | 1 UN | 5.500,58 |
| 77 | InventoryGenEntries / 110 / 0 | 69 | 2259 | 1 UN | 108,84 |
| 79 | InventoryGenEntries / 111 / 0 | 70 | 2262 | 1 UN | 108,81 |

Saidas 77, 78, 79 e 80 tem respectivamente `DocNum` 30, 31, 32 e 33 e
`TransNum` 2254, 2256, 2258 e 2261. Todos esses documentos e recebimentos sao de
28/09/2026, filial 1, moeda `R$`, nao cancelados na auditoria aprovada.

| Informacao | Entidade e identificacao | Campo / derivacao |
|---|---|---|
| Numero visivel da OP | ProductionOrders(203/204/206) | DocumentNumber = 76/77/79; nao confundir com chave |
| Item, planejado e concluido | Mesmas OPs; cabecalho, sem linha | ItemNo, PlannedQuantity, CompletedQuantity, InventoryUOM |
| Componente e quantidade emitida | ProductionOrders(key).ProductionOrderLines[LineNumber] | ItemNo, ItemType, IssuedQuantity; ligacao por BaseEntry/BaseLine da saida |
| Material/recurso consumido | InventoryGenExits(DocEntry).DocumentLines[LineNum] | ItemCode, ItemDescription, Quantity, MeasureUnit, UnitPrice, Price, LineTotal |
| Produto recebido | InventoryGenEntries(DocEntry).DocumentLines[0] | ItemCode, Quantity, InventoryQuantity, MeasureUnit, LineTotal, UnitPrice, TransactionType=botrntComplete |
| Custo absorvido observado | Linhas dos recebimentos acima | Soma de LineTotal, conferida contra saidas; nao e campo de custo atual |
| Custo unitario historico | Mesmas linhas | Soma de LineTotal / soma de InventoryQuantity; divisao explicita |
| Conta e dimensoes do movimento | DocumentLines | AccountCode, CostingCode e CostingCode2..5 |
| Lancamento contabil | JournalEntries(TransNum).JournalEntryLines[Line_ID] | AccountCode, Debit, Credit, BPLID, CostingCode e CostingCode2..5 |
| Fechamento | ProductionOrders.TransactionNumber | 2257, 2260 e 2263; JournalEntries.Original = 203, 204 e 206 |

Os lancamentos de fechamento **nao sao custo adicional** a somar ao recebido.
A soma dos debitos de 2257/2260/2263 (9.000,00 / 125,84 / 125,81) inclui
contrapartidas. Nos recebimentos 110/111 o debito e em Variacao do Custo Medio;
no 109 e em Mercadorias para Revenda. Isso limita interpretar "absorvido" como
estoque capitalizado hoje. Nao se alterou a determinacao contabil.

## 2. Composicao dos recursos

Fonte complementar: `Resources('codigo')`, campos selecionados registrados em
`functional-source.json.queries`; `ResourceGroups(1)` lido integralmente.
Essas entidades usam **Code**, nao DocEntry nem linha de documento.

| Codigo | Descricao | Type | Unidade | Cost1 | Cost2 | Cost3..10 | Soma atual Cost1..10 | Grupo |
|---|---|---|---|---:|---:|---|---:|---|
| R300007 | Hora de Montagem Tecnico | rtLabor | horas | 3.000,00 | 1.500,00 | Todos 0 | 4.500,00 por unidade cadastrada | 1 - Recursos |
| R300010 | Separador de Materia Prima | rtLabor | null | 5,00 | 0,00 | Todos 0 | 5,00; unidade nao informada | 1 - Recursos |
| R300011 | Empilhadeira | rtMachine | null | 12,00 | 0,00 | Todos 0 | 12,00; unidade nao informada | 1 - Recursos |

No grupo 1, `CostName1..10` dizem apenas **"Custo padrao do recurso 1"** ate
**"Custo padrao do recurso 10"**. `ResourceGroups.Cost1..10` sao todos zero;
nao substituem os valores nao zero dos cadastros individuais. O grupo tem
`Type=rtMachine`, mas dois recursos tem `Type=rtLabor`: preservar o tipo do
recurso, nao deduzir todos como maquinas pelo grupo.

O modelo SAP permite componentes de custo padrao configuraveis e valores no
recurso que diferem dos valores padrao do grupo. Isso explica a estrutura,
**nao a composicao economica desta empresa**.
[Definicoes oficiais de recursos](https://help.sap.com/docs/SAP_BUSINESS_ONE_WEB_CLIENT/2554bf7e9aa347729b0547a737e123ac/42f028be105143b68335c4406866d851.html).

### Origem, contas e dimensoes

| Evidencia | R300007 | R300010 | R300011 |
|---|---|---|---|
| IssueMethod atual do cadastro | rimBackflush | rimManual | rimBackflush |
| Metodo nas linhas historicas das OPs | im_Backflush | im_Backflush | im_Backflush |
| LinkedItem | null | null | null |
| ResourceFixedAssets | Colecao vazia | Colecao vazia | Colecao vazia |
| ResourceEmployees | Um vinculo cadastral | Um vinculo cadastral | Colecao vazia |
| Remarks | Vazio | null | null |
| Conta nas linhas de consumo | 4.01.01.04.07 | 4.01.01.04.07 | 4.01.01.04.07 |
| Dimensoes 1..5 nas linhas de consumo | Todas null | Todas null | Todas null |
| Dimensoes 1..5 nas linhas do razao dessa conta | Todas vazias | Todas vazias | Todas vazias |
| UnitsPerTime / TimePerUnits | 1 / 3600 | 1 / 30 | 1 / 15 |

`ResourceEmployees` comprova apenas vinculo cadastral, nao folha de pagamento,
salario incorporado ou apontamento. Nao foram lidos dados pessoais de empregados.
`ResourceFixedAssets=[]` nao prova ausencia de depreciacao embutida no preco.
`TimePerUnits` e parametro de capacidade, nao tempo real consumido.

As OPs 77/79 e seus recebimentos informam `DistributionRule`/`CostingCode=Pr_Acab`
na dimensao 1, mas isso **nao preenche retroativamente** as dimensoes vazias do
consumo/conta de recursos. `Pr_Acab` e Producao - Acabamentos, regra direta
100% para o centro de mesmo codigo, vigente desde 01/02/2020, sem fim informado.

A conta 4.01.01.04.07 tem nome **Despesas Assessoria e Consultoria**, sob o grupo
**DESPESAS ADMINISTRATIVAS**, apesar do uso real nesses recursos. O nome da conta
nao converte o recurso em consultoria, nem prova que o custo contem GGF.
`ChartOfAccounts.CostElementCode` e `LoadingFactorCode..5` estao null nessa conta.

Nao ha campo de conta por componente `CostN` nas projecoes de Resources e
ResourceGroups verificadas. A associacao comprovada e **recurso -> linha de
saida -> AccountCode/TransNum -> lancamento**, nao um vinculo demonstrado entre
Cost1 ou Cost2 individualmente e uma conta. SAP admite determinacao contabil de
recursos e regras avancadas, portanto nao presumimos uma regra global a partir
de tres consumos.
[Determinacao de contas de recursos](https://help.sap.com/docs/SAP_BUSINESS_ONE/f19b844f41b74a8c8ca26f4d501e032b/d70ee8a79c394e7a8d46a7b4cbc59a3b.html).

**Resposta a pergunta central:** os tipos rtLabor/rtMachine e os valores atuais
estao demonstrados. **Nao foi possivel determinar se Cost1/Cost2 incluem mao de
obra, energia, depreciacao ou outro GGF.** Os nomes sao genericos, nao ha memoria
da formacao da tarifa ou origem documental por componente nas fontes lidas.
A igualdade da tarifa atual com UnitPrice historico nao comprova vigencia nem
composicao historica. Historico de formacao da tarifa permanece uma lacuna tecnica,
nao uma resposta que devemos inventar.

## 3. Contas candidatas e censo contabil do periodo

Foram lidos **67 lancamentos / 497 linhas / 34 contas**, com **96.074,50** em
debitos e creditos. O valor global nao e gasto industrial nem pool GGF.
Foram preservadas **50 combinacoes** conta/filial/dimensoes no JSON de resumo,
incluindo a diferenca entre `null` e string vazia. Todos os movimentos capturados
tem `BPLID=1`, nome **Ramo**; filiais 2/3 existem mas nao tem linhas neste recorte.

Consulta: `JournalEntries` filtrada por `ReferenceDate ge '2026-09-01' and
ReferenceDate le '2026-09-30'`, sem filtro de filial/dimensao e sem excluir
origens, creditos, linhas zeradas ou estornos. Valores nao foram absolutizados.
`JdtNum` e o identificador usado aqui como **TransId**; `OriginalJournal` e o
tipo de origem e `Original` a chave do documento de origem. Quantidade de
lancamentos significa JdtNum distintos por conta, nao numero de linhas.

### Classificacao tecnica, nao regra GGF

- **A:** potencial gasto indireto industrial (sugestao de investigacao).
- **B:** potencial custo direto/valor ja ligado a producao, sem certificar sua
  natureza economica nem aprovar sua participacao como denominador de rateio.
- **C:** administrativo/comercial/outros, inclusive financeiro, patrimonial e fiscal.
- **D:** nao foi possivel determinar; fontes misturadas ou natureza insuficiente.

Nenhuma classificacao e gravada no cadastro nem aplicada pelo motor. O censo
inteiro evita selecionar apenas contas cujo nome pareca industrial.

### Contas industriais previstas no plano, sem movimento

`ChartOfAccounts.FatherAccountKey=5.01.02.09`, cujo nome e **CUSTOS INDIRETOS
APLICADOS NA PRODUCAO**, sob **CUSTO DOS PRODUTOS DE FABRICACAO PROPRIA PRODUZIDOS**.
Todos os sete registros abaixo sao analiticos (`ActiveAccount=tYES`). Classificacao
**A apenas pela hierarquia do plano**, sem comprovar despesa efetiva neste mes.

| Conta | Nome | Debito | Credito | Liquido | Dimensao / filial | Lancamentos / origem / TransId | Relacao com producao |
|---|---|---:|---:|---:|---|---|---|
| 5.01.02.09.01 | Alugueis | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.02 | Despesas com Veiculos e de Conservacao de Bens e Instalacoes | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.03 | Agua e Esgoto | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.04 | Energia Eletrica | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.05 | Internet | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.06 | Telefone | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |
| 5.01.02.09.07 | Despesa com Seguranca | 0,00 | 0,00 | 0,00 | Sem linhas; nao atribuida | 0 / nenhuma / nenhum | Grupo industrial do plano |

Zero aqui resulta da ausencia de linhas em uma coleta completa do periodo,
nao de campos financeiros ausentes substituidos por zero. Nao significa saldo
acumulado zero. Tambem nao movimentaram 4.01.01.04.01 (Alugueis), .03 (Agua),
.04 (Energia), 4.01.01.05.31 (Manutencao/Reparo de Maquinas), 4.01.01.08.01
(Depreciacao) e 5.01.02.02.02 (Ordenados/Salarios). Nao reclassificamos gastos
administrativos como industriais so pelo nome.

### Contas movimentadas: lista completa

Todas as linhas desta tabela sao da **filial 1 (Ramo)**. Dimensoes: **V** =
cinco strings vazias; **N** = cinco null; **M** = dimensao 1 `Ad_Manut`
(Admin - Manutencao Predial); **P** = dimensao 1 `Pr_Acab` (Producao - Acabamentos).
Em M/P, dimensoes 2..5 sao vazias. Multiplas letras mostram escopos presentes,
nao uma distribuicao presumida. Os valores detalhados por escopo estao no JSON.

Origens: **AP**=ttAPInvoice; **AR**=ttARInvoice; **NC**=ttARCredItnote;
**RC**=ttReceipt; **PG**=ttVendorPayment; **LC**=ttJournalEntry;
**AD**=ttDownPayment; **EM**=ttPurchaseDeliveryNote;
**SP**=ttGeneralReleaseFromStock; **RP**=ttGeneralReceiptToStock;
**OP**=ttProductionOrder. Sao os enums retornados, nao inferencias pelo nome da conta.

Relacao: **R1**=saida/recebimento das OPs alvo, mas tambem outras operacoes;
**R2**=somente ciclo contabil das OPs alvo;
**R3**=recebimentos OP77/79 misturados com compra;
**-**=nenhum vinculo com as tres OPs comprovado nas fontes lidas.

| Conta / nome | Classe | Debito | Credito | Liquido | Dim. | N lanc. | Origens | Exemplos TransId | Relacao |
|---|---|---:|---:|---:|---|---:|---|---|---|
| 1.01.01.01.01 Caixa Geral | C | 3.836,79 | 4.125,81 | -289,02 | N | 14 | RC,PG,LC | 2211,2220,2222 | - |
| 1.01.01.02.01 Banco Bradesco | C | 832,06 | 1.256,00 | -423,94 | V,N | 3 | LC,PG,RC | 2214,2191,2224 | - |
| 1.01.01.02.02 Banco Itau Novo | C | 6.500,00 | 0,00 | 6.500,00 | V,N | 11 | LC | 2243,2244,2245 | - |
| 1.01.02.01.01 Mercadorias para Revenda | D | 14.061,43 | 8.505,26 | 5.556,17 | V | 28 | AP,AR,EM,SP,RP | 2190,2254,2255 | R1 |
| 1.01.02.01.03 Produtos em Elaboracao | B | 5.718,23 | 5.718,23 | 0,00 | V | 10 | SP,RP,OP | 2254,2255,2256 | R2 |
| 1.01.02.01.99 Transitoria - Recebimento Fisico/Fiscal | C | 854,75 | 854,75 | 0,00 | V | 2 | EM,AP | 2198,2199 | - |
| 1.01.03.01.01 Clientes Nacionais | C | 20.598,85 | 11.257,85 | 9.341,00 | V,N | 36 | LC,AR,NC,AD,RC | 2214,2194,2195 | - |
| 1.01.03.03.01 Cheques Recebidos | C | 2.032,60 | 0,00 | 2.032,60 | N | 3 | RC | 2204,2209,2239 | - |
| 1.01.03.06.01 ICMS e Contribuicoes a Recuperar | C | 2.521,81 | 0,00 | 2.521,81 | V,M | 6 | AP | 2192,2199,2200 | - |
| 1.01.03.06.02 IPI a Recuperar | C | 349,65 | 0,00 | 349,65 | V,M | 3 | AP | 2201,2237,2200 | - |
| 1.01.03.06.03 PIS a Recuperar | C | 166,43 | 0,00 | 166,43 | V,M | 6 | AP | 2192,2199,2200 | - |
| 1.01.03.06.04 COFINS a Recuperar | C | 766,63 | 0,00 | 766,63 | V,M | 6 | AP | 2192,2199,2200 | - |
| 2.01.01.01.01 Fornecedores Nacionais | C | 1.256,00 | 15.692,24 | -14.436,24 | V,N | 13 | LC,AP,PG | 2243,2190,2191 | - |
| 2.01.01.01.02 Fornecedores Estrangeiros | C | 393,75 | 0,00 | 393,75 | N | 1 | PG | 2236 | - |
| 2.01.01.02.01 Adiantamentos de Clientes | C | 3.356,00 | 3.956,00 | -600,00 | V,N | 10 | AD,AR,NC | 2203,2208,2221 | - |
| 2.01.01.05.01 ICMS e Contribuicoes a Recolher | C | 1.333,36 | 4.735,78 | -3.402,42 | V | 19 | AR,NC | 2194,2195,2196 | - |
| 2.01.01.05.03 PIS a Recolher | C | 87,98 | 316,55 | -228,57 | V | 20 | AR,NC | 2194,2195,2196 | - |
| 2.01.01.05.04 COFINS a Recolher | C | 405,36 | 1.458,33 | -1.052,97 | V | 20 | AR,NC | 2194,2195,2196 | - |
| 2.01.01.05.07 ISS a Recolher | C | 0,00 | 12,25 | -12,25 | V | 1 | AR | 2238 | - |
| 2.03.02.01.06 Outras Reservas | D | 822,35 | 1.166,48 | -344,13 | V,M | 25 | AR,NC,AP | 2194,2195,2200 | - |
| 3.01.01.01.02 Vendas de Mercadorias para Mercado Interno | C | 2.038,71 | 19.188,06 | -17.149,35 | V | 17 | AR | 2194,2195,2196 | - |
| 3.01.01.02.01 Vendas Canceladas, Devolucoes e Descontos Incondicionais | C | 4.414,99 | 0,00 | 4.414,99 | V | 3 | NC | 2197,2206,2213 | - |
| 3.01.01.02.02 ICMS (deducao) | C | 4.735,78 | 1.333,36 | 3.402,42 | V | 19 | AR,NC | 2194,2195,2196 | - |
| 3.01.01.02.04 PIS/PASEP (deducao) | C | 316,55 | 87,98 | 228,57 | V | 20 | AR,NC | 2194,2195,2196 | - |
| 3.01.01.02.05 COFINS (deducao) | C | 1.458,33 | 405,36 | 1.052,97 | V | 20 | AR,NC | 2194,2195,2196 | - |
| 4.01.01.04.07 Despesas Assessoria e Consultoria | B | 4.534,00 | 9.068,00 | -4.534,00 | V | 6 | SP,OP | 2254,2257,2258 | R2 |
| 4.01.02.01.01 Variacoes Cambiais Passivas | C | 379,56 | 0,00 | 379,56 | V,N | 3 | AP,RC,PG | 2192,2220,2236 | - |
| 4.01.02.01.06 Arredondamento por Diferencas de Moeda | C | 0,00 | 130,00 | -130,00 | N | 1 | AP | 2192 | - |
| 5.02.01.01.01 Custo das Mercadorias Revendidas | C | 7.321,03 | 1.847,29 | 5.473,74 | V | 19 | AR,NC | 2194,2195,2196 | - |
| 5.03.01.01.01 Variacao do Custo Medio | D | 217,65 | 195,05 | 22,60 | V,P | 3 | AP,RP | 2237,2259,2262 | R3 |
| 5.03.01.01.99 Outros Custos | B | 4.717,65 | 4.717,65 | 0,00 | V,P,N | 3 | OP | 2257,2260,2263 | R2 |
| 6.01.01.01.03 CBS | C | 22,19 | 22,19 | 0,00 | V | 2 | AP | 2190,2192 | - |
| 6.01.01.01.04 IBS UF | C | 13,25 | 13,25 | 0,00 | V,M | 27 | AP,AR,NC | 2190,2192,2200 | - |
| 6.01.01.01.05 IBS Mun | C | 10,78 | 10,78 | 0,00 | V,M | 25 | AR,NC,AP | 2194,2195,2200 | - |
| **Total (contas, nao pool)** | - | **96.074,50** | **96.074,50** | **0,00** | - | **67 distintos globalmente** | - | - | - |

Contagens por conta nao podem ser somadas para obter 67: um lancamento afeta
varias contas. A categoria D de Outras Reservas evita atribuir natureza de gasto
a uma conta patrimonial usada em varias origens, sem ler sua determinacao fiscal.

### Abertura dos casos relevantes por origem e dimensao

Todos filial 1; dimensoes 2..5 vazias, exceto a linha N (todas null).

| Conta | Dimensao 1 | Origem | Debito | Credito | Liquido | N lanc. | TransId / Line_ID |
|---|---|---|---:|---:|---:|---:|---|
| 4.01.01.04.07 | Vazia | SP | 4.534,00 | 4.534,00 | 0,00 | 3 | 2254/2,3; 2258/2,3; 2261/2,3 |
| 4.01.01.04.07 | Vazia | OP | 0,00 | 4.534,00 | -4.534,00 | 3 | 2257/2; 2260/3; 2263/3 |
| 5.03.01.01.01 | Vazia | AP | 0,00 | 195,05 | -195,05 | 1 | 2237/11 |
| 5.03.01.01.01 | Pr_Acab | RP | 217,65 | 0,00 | 217,65 | 2 | 2259/1; 2262/1 |
| 5.03.01.01.99 | Vazia | OP | 217,65 | 0,00 | 217,65 | 2 | 2260/2,4; 2263/2,4 |
| 5.03.01.01.99 | Pr_Acab | OP | 0,00 | 217,65 | -217,65 | 2 | 2260/1; 2263/1 |
| 5.03.01.01.99 | null (N) | OP | 4.500,00 | 4.500,00 | 0,00 | 1 | 2257/1,3 |

Filtrar apenas linhas sem dimensao faria Outros Custos parecer gasto de 217,65,
embora o saldo da conta inteira seja zero. Nenhuma regra de dimensao foi aplicada
ao GGF. A presenca de `Pr_Acab` comprova vinculo industrial, **nao novo gasto**.

## 4. RISCO DE DUPLA ABSORCAO

Trata-se de **risco**, nao afirmacao de contabilizacao duplicada ja existente.
Os lancamentos atuais sao evidencias do fluxo; nao foram corrigidos nem julgados
como erro contabil. Nao existe pool escolhido para afirmar duplicidade efetiva.

| Conta | Recurso relacionado | Evidencia encontrada | Risco se usada novamente no pool | Confirmacao funcional necessaria |
|---|---|---|---|---|
| 4.01.01.04.07 | R300007 | Saida 77/0, 4.500,00, AccountCode dessa conta; JE2254/2,3 e JE2257/2; recebido OP76 inclui o valor | Reaplicar custo ja incorporado; usar somente debitos daria falso gasto novo; usar modulo do saldo perderia o sinal | Papel dessa conta na absorcao, composicao Cost1/Cost2 e tratamento das origens de producao no futuro pool |
| 4.01.01.04.07 | R300010 e R300011 | Saidas 79/0,1 e 80/0,1, total 34,00; JE2258/2,3, 2261/2,3 e fechamentos2260/3,2263/3 | Reaplicar 34,00 ja nos recebimentos; JE agrega os dois recursos, sem separacao por CostN | Composicao das tarifas5/12 e como excluir absorcoes sem eliminar despesas externas legitimas |
| 5.03.01.01.99 | R300007, e conjunto materiais/recursos OP77/79 | JE2257/3 debita4.500; JE2260/4 e2263/4 debitam17 cada; conta zera com outras linhas | Debito bruto ou recorte de dimensao produz pool artificial de valores do proprio fechamento | Tratamento de contas de fechamento e regra de recorte de dimensoes |
| 5.03.01.01.01 | R300010/R300011 dentro do valor total dos produtos | JE2259/1 e2262/1 debitam108,84/108,81, exatamente os recebimentos; tambem ha credito de compra195,05 | Redistribuir o produto ja valorizado como se fosse gasto indireto novo | Tratamento de variancias de valorizacao e separacao de origem, nao apenas saldo total22,60 |
| 1.01.02.01.03 e 1.01.02.01.01 | Recursos compoem parte do produto recebido; materiais tambem | WIP debito/credito5.718,23; recebimento109 debita estoque5.500,58; saidas creditam materiais | Somar transferencias patrimoniais e custo do produto ao pool | Delimitar custo absorvido versus gasto elegivel; nao interpretar debito de estoque como despesa |
| 5.01.02.09.04 / 4.01.01.08.01 (sem movimento) | Nenhum vinculo por componente comprovado | Energia e depreciacao existem no plano, mas CostNameN genericos e nenhum movimento nessas contas no mes | Sobreposicao futura possivel, **nao demonstrada nesta captura** | Formacao economica das tarifas antes de incluir energia/depreciacao no pool |

O fato de ambos os lados de uma conta coincidirem em uma saida nao elimina o
risco no mes: ha creditos adicionais nos fechamentos. A falta de identificacao
do componente de tarifa impede afirmar "Cost2 = energia" ou "Cost1 = salario".

## 5. Bases de rateio realmente disponiveis

Tabela de **medidas observadas**, nao novos criterios implementados ou aprovados.
ND = nao demonstrado; nao substituido por zero. Totais fisicos so fazem sentido
no escopo/unidade indicados. Os quatro criterios existentes continuam intactos.

| Base / origem | Unidade | OP76 | OP77 | OP79 | Total | Limitacoes |
|---|---|---:|---:|---:|---|---|
| Produzido recebido: InventoryGenEntries.DocumentLines.InventoryQuantity | UN por ItemCode | 1 C00003 | 1 z202604 | 1 z202604 | C00003=1; z202604=2 | Soma bruta3 UN nao prova equivalencia de esforco entre produtos |
| Concluido: ProductionOrders.CompletedQuantity | InventoryUOM=UN | 1 | 1 | 1 | 3 brutas; mesmos subconjuntos acima | Confere com recebimentos; nao converter automaticamente em unidades equivalentes |
| Planejado: ProductionOrders.PlannedQuantity | UN por item | 1 | 1 | 1 | 3 brutas | Planejamento, nao outra producao a somar ao realizado |
| R300007 consumido: saida77/0.Quantity | horas cadastradas de recurso | 1 | 0 | 0 | 1 desse recurso | Quantidade backflush; **nao 1 hora apontada** nem base de horas reais |
| R300010 consumido: saidas79/0,80/0.Quantity | ND | 0 | 1 | 1 | 2 quantidades do mesmo codigo | Sem unidade; nao somar com outros recursos nem converter em tempo |
| R300011 consumido: saidas79/1,80/1.Quantity | ND | 0 | 1 | 1 | 2 quantidades do mesmo codigo | Sem unidade; nao somar com R300010 |
| Valor de recurso: saidas dit_Resource.LineTotal | Moeda local | 4.500,00 | 17,00 | 17,00 | 4.534,00 | Observavel; composicao desconhecida, pode conter custos indiretos embutidos |
| Valor de material: saidas dit_Item.LineTotal | Moeda local | 1.000,58 | 91,84 | 91,81 | 1.184,23 | Consumo historico valorizado; escopo do denominador depende de escolha funcional |
| Custo dos componentes observados: materiais + recursos | Moeda local | 5.500,58 | 108,84 | 108,81 | 5.718,23 | Nao e custo atual de estoque; definicao funcional de custo direto nao aprovada |
| Valor recebido: entradas.LineTotal | Moeda local | 5.500,58 | 108,84 | 108,81 | 5.718,23 | E conferencia da medida anterior, nao mais um custo a adicionar |
| Numero de linhas materiais consumidas | Contagem de linhas | 12 | 3 | 3 | 18 ocorrencias | Nao mede esforco; soma duplica os mesmos codigos entre OP77/79 |
| Numero de linhas recursos consumidas | Contagem de linhas | 1 | 2 | 2 | 5 ocorrencias, 3 codigos distintos | Nao soma unidades nem horas; grupo1 em todas |
| Quantidade de componentes com MeasureUnit=UN | UN de itens diferentes | 12 | 1 | 1 | 14 brutas | Itens heterogeneos; nao normalizado |
| Quantidade de componentes com MeasureUnit=KG | KG declarados de componentes | 0 | 2 | 2 | 4: Aluminio2 e Areia Verde2 | Nao e peso do produto acabado nem equivalencia de esforco |
| Peso de estoque: Items.InventoryWeight/Unit | ND | ND | ND | ND | ND | Ambos os produtos retornam null, inclusive Weight1/Unit1 |
| Peso cadastral de venda/compra: Items.SalesUnitWeight/PurchaseUnitWeight | kg via WeightMeasures(3) | 0,66 no cadastro C00003 | ND | ND | ND | Conversao para unidade de producao nao comprovada; nao e pesagem do recebido |
| Horas reais: ProjectManagementTimeSheet, auditoria aprovada | Horas apontadas | ND | ND | ND | ND | Zero linhas de setembro, nao zero horas trabalhadas; nenhum vinculo com essas OPs |
| Grupo de recurso: Resources.Group | Identificador, nao peso | 1 | 1 | 1 | Um grupo: Recursos | Nao fornece percentuais aprovados ou horas dentro do grupo |

As linhas de documentos retornam `Weight1=0` e `Weight1Unit=null`; nao foram
tratadas como prova de produto com peso zero. `TimePerUnits` 3600/30/15 e
`UnitsPerTime=1` sao parametros, nao uma base temporal medida. Datas iguais de
liberacao/fechamento tambem nao fornecem duracao de trabalho. Nao houve
conversao para horas, peso total, producao equivalente ou percentual de grupo.

## 6. Campos sem informacao e lacunas de evidencia

| Campo / evidencia | Estado encontrado | Consequencia |
|---|---|---|
| RecursosR300010/11.UnitOfMeasure e MeasureUnit das saidas | null | Quantidades sem unidade normalizada |
| ResourceGroups.CostName1..10 | Nomes genericos | Nao identifica energia, mao de obra, depreciacao etc. |
| Historico/documento formador de Cost1..10 | Nao demonstrado nas fontes lidas | Tarifa atual nao prova composicao/validade na data do consumo |
| Conta por componente CostN | Nao demonstrada | Conta de consumo comprovada, mas nao decomposicao contabil individual dos componentes |
| Recursos.ResourceFixedAssets | Colecoes vazias | Nenhuma ligacao de ativo encontrada; depreciacao embutida continua indeterminada |
| Recursos.LinkedItem / DefaultWarehouse | null | Nao derivar custo ou deposito por esses campos |
| Dimensoes nas saidas de recurso | null; JE de recursos vazio | Nao herdar Pr_Acab por conveniencia |
| OP76.DistributionRule1..5 | Vazias | Nao atribuir centro industrial presumido |
| Items.InventoryWeight/Unit e Weight1/Unit1 | null nos dois produtos | Peso de producao incompleto |
| Peso de venda/compra z202604 | null | Nao completar com0,66 do outro produto |
| Horas reais de setembro | Nenhuma linha na auditoria aprovada | Criterios horas e grupo/horas sem base demonstrada |
| Equivalencia entre os produtos C00003 e z202604 | Nao demonstrada | UN nao basta para comparar esforco industrial |
| Custo atual do estoque por OP | Nao levantado integralmente | Recebimentos nao substituem reavaliacoes, vendas/consumos posteriores e saldo remanescente |
| Faturas de energia, depreciacao ou salario ligadas aos CostN | Nenhum vinculo comprovado | Nao afirmar duplicidade economica efetiva; apenas risco |

Faltas tecnicas nao viram decisoes arbitrarias do usuario. Antes de integrar
essas bases, devemos buscar a memoria de tarifa e a determinacao contabil no
SAP/na fonte responsavel, conferir historico quando disponivel e demonstrar
conversoes. Caso tais informacoes sejam mantidas fora do SAP, sua origem tera
de ser identificada e versionada. Nao foram criadas consultas SQL nem endpoints.

## 7. Decisoes funcionais pendentes e limites

Hoje e possivel observar o custo documentado das tres OPs e os movimentos do
periodo, mas **nao existe pool oficial nem denominador oficial**. Categorias
A/B/C/D deste documento servem para revisao humana, nao configuracao.

Ficam separados: recurso consumido, eventual componente indireto da tarifa,
despesa externa do periodo, absorcao contabil e valor recebido. Esses conceitos
nao podem ser colapsados em uma soma apenas porque debitos/creditos conciliam.
Conferencia independente no cliente SAP e documentos de formacao de tarifa
ainda sao necessarias; nao declaramos validacao contabilidade/estoque final.

### Rastreabilidade e reproducao

Com a captura aprovada disponivel e `.env` local ignorado:

```sh
npm run ggf:sap:functional
```

O comando exige SBODEMOBR2, setembro/2026 e chaves203/204/206; nao executa o
comando `ggf:sap:orders`. Registra SHA-256 da captura aprovada utilizada:
`24e299d7eb872ab2a088e91dae3723a4273fdcc33f58ddb61a43ff65a390244b`.
Data da captura base: 28/09/2026 13:43:26 UTC. Resultados locais, ignorados:

- `.local/ggf/functional-source.json`: registros complementares, consultas,
  controles, escopos, identificacao e hash da base reutilizada.
- `.local/ggf/functional-report.json`: valores por conta/filial/cinco dimensoes,
  quantidade distinta de lancamentos, linhas, origens e todas as referencias.

Leituras complementares: JournalEntries67 (4 paginas), ChartOfAccounts639
(32), Dimensions5 (1), ProfitCenters39 (2), DistributionRules37 (2),
BusinessPlaces3 (1), WeightMeasures5 (1). Mais tres recursos por chave, um
grupo por chave, dois itens por chave e67 releituras individuais dos lancamentos.
Todas as colecoes conferem IDs distintos, exaustao da paginacao e `$count`,
reconferido ao final. Linhas aninhadas com continuacao sao rejeitadas.
Lancamentos sao comparados integralmente com releituras de mesma projecao e
conferidos por igualdade debito/credito em moeda local. Nao foi encontrada
diferenca estrutural; totais globais coincidem com o levantamento anterior.

Contagem/releitura sao controles da mesma fonte, **nao uma conciliacao externa**
nem snapshot transacional. Cadastros podem mudar apos a leitura. Dados base e
suplementares tem instantes diferentes explicitados; nao se presume atomicidade.
Somente GET de negocio; POST restrito a Login/Logout pelo transporte existente.
TLS verificado, sem desabilitacao de certificado. Nenhuma credencial em extratos,
testes ou neste documento. Sem alteracao de dados, metadados, custos ou estoque.

### Arquivos e verificacoes desta etapa

- Novo documento `docs/GGF-FUNCTIONAL-DIAGNOSTIC.md`.
- Novos `scripts/ggf-sap-functional-diagnostic.mjs` e
  `scripts/ggf-functional-diagnostic-lib.mjs` (apenas diagnostico local).
- Novo `test/ggf/functionalDiagnostic.test.ts`, com dados inventados para testes
  offline; nenhuma credencial ou extrato real usado como fixture.
- `package.json`: comando `ggf:sap:functional`.
- `README.md` e `docs/GGF-READ-MAPPING.md`: links para esta etapa.

Nao houve mudanca de interface, motor, adaptador normalizado, configuracao GGF
ou bloqueios. Alteracoes locais anteriores preservadas.

Verificacoes finais executadas:

- `npm test`: **292 testes aprovados em 23 arquivos**, incluindo 15 novos testes
  offline de precisao, sinais, dimensoes, filial, contagem, origens, colecoes
  incompletas e limites do coletor complementar.
- `npm run typecheck`: aprovado.
- `npm run build:module`: aprovado, preservando o empacotamento existente.
- Conferencia automatizada das 34 linhas da tabela contabil contra o JSON:
  debitos, creditos, liquidos e contagens distintos de lancamentos coincidem.
- Soma offline dos componentes da captura aprovada: materiais1.184,23 +
  recursos4.534,00 = recebimentos5.718,23, sem afirmar validade do rateio.
- Hash da captura aprovada inalterado; zero consultas novas a ProductionOrders,
  InventoryGenEntries, InventoryGenExits ou ProjectManagementTimeSheet.
- `.env` e os dois extratos complementares confirmados como ignorados pelo Git.
- `git diff --check -- . ':!.gitignore'`: aprovado; `.gitignore` tem alteracao
  preexistente, nao editada nesta etapa.

Testes de navegador nao foram reexecutados: nao houve alteracao de interface.

## DECISOES QUE O USUARIO PRECISA TOMAR

1. **Pool elegivel:** quais naturezas, contas e origens podem compor GGF e quais
   absorcoes/transferencias/variancias devem ficar fora; os nomes e saldos do
   SAP nao estabelecem essa politica. Nenhuma das contas foi selecionada.
2. **Fronteira das tarifas:** apos comprovar a composicao de CostN, quais parcelas
   serao tratadas exclusivamente pela tarifa do recurso e quais pelo GGF, sem
   dupla absorcao; nao e uma decisao sobre "inventar" a composicao ausente.
3. **Escopo e competencia:** quais OPs, estados, datas e filiais/dimensoes participam
   do fechamento; como tratar valores sem dimensao e regras de abrangencia. As
   tres OPs aprovadas sao conjunto de validacao, nao elegibilidade definitiva.
4. **Base por natureza de gasto:** custo direto (materiais apenas ou materiais e
   parcelas elegiveis de recursos), quantidade produzida com equivalencia
   justificada, ou horas/grupos somente quando houver fonte real completa. Nao
   escolher horas a partir de capacidade ou backflush.
5. **Sinais e ajustes:** tratamento funcional de creditos, estornos e variancias
   no futuro pool; nao transformar saldo credor em gasto positivo automaticamente.
6. **Destino do fechamento futuro:** significado funcional de custo atual e
   tratamento de estoque remanescente versus produto ja consumido/vendido, antes
   de propor qualquer reavaliacao ou lancamento. Contabilizacao continua bloqueada.
