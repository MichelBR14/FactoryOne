# GGF V2: plano de migracao para fechamento por absorcao

## Escopo e estado comprovado

Este documento e uma proposta arquitetural, nao uma mudanca de regra ou uma
homologacao contabil. Nenhum codigo, UDO, dado SAP ou documento financeiro foi
alterado nesta etapa. A V1 e suas evidencias permanecem intactas. A analise usa o
codigo presente no workspace em 29/09/2026; varios arquivos GGF ainda estao
fora do historico Git, portanto um commit antigo nao representa o estado atual.

O objetivo da V2 e explicitar o fluxo:

```text
custo real contabil elegivel
- custo padrao ja absorvido e comprovado
= saldo liquido a absorver
-> rateio por OP
-> parcela em estoque x parcela ja consumida / outras saidas
-> propostas contabeis distintas, quando homologadas
-> reconciliacao e fechamento persistente
```

"Custo padrao ja absorvido" significa a parcela economica previamente aplicada
as OPs e contabilmente comprovada; **nao** significa que o item produzido usa o
metodo de avaliacao `bis_Standard`. O SAP B1 pode incluir recursos, mao de obra e
outros adicionais no custo da OP, inclusive por componentes de custo padrao de
recurso. A documentacao SAP descreve [custos adicionais de producao](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727/44f29300df7365fbe10000000a1553f7.html),
[componentes/contas dos recursos](https://help.sap.com/docs/SAP_BUSINESS_ONE/f19b844f41b74a8c8ca26f4d501e032b/9862f0b3e7f74e9bb04af71685654f6a.html)
e [custeio das OPs por metodo de avaliacao](https://help.sap.com/docs/PRODUCT_ID/68a2e87fb29941b5bf959a184d9c6727/689975f9caea438ba98206fce1573bcb.html).
Isso justifica a investigacao de dupla absorcao; nao identifica automaticamente
as contas nem a parcela ja absorvida desta empresa.

## Arquitetura atual

```text
SAP Service Layer -> leitura paginada + contagens -> snapshot normalizado
     -> ClosingSession -> allocate (4 criterios, centavos, memoria) -> CSV
                              |
                              +-> previa de custo/estoque e simulador de payload

UDO CLOSE/CLINE/CLAIM/CVERS -> fechamento, hash, versoes, integridade
     -> coordenador de POST injetavel (sem ligacao com o botao UI)
```

- `MappedGgfSource` pagina, valida identidade, fim da paginacao e `/$count`.
  `SapB1ReadMapping` e um diagnostico: seu `normalize()` **bloqueia** rateio.
  `SapGgfCalculationSource` calcula com dados SAP reais, mas apenas para
  setembro/2026, OPs 76/77/79 (DocEntry 203/204/206), sem filial/dimensao e
  com politica opcional explicita de materiais+recursos. Horas reais seguem
  indisponiveis nesse recorte. O comando `ggf:sap:calculate` nao e o assistente.
- `allocate` recebe `AccountBalance.amount` como debito menos credito da conta
  selecionada, aplica o percentual e reparte diretamente por custo, quantidade,
  horas ou grupo. Tem aritmetica deterministica e evidencias de base, mas
  **nao calcula custo real menos absorcao anterior**. `AllocationResult.total`
  representa hoje o valor aplicavel das contas, nao o saldo V2.
- O cadastro de classificacoes/rateios e o Wizard SAPUI5 calculavel usam
  `DevelopmentGgfRepository` e `localStorage`; no modo `sap-read`, a tela
  mostra diagnostico de fontes e consulta de integridade, nao um fechamento
  funcional integrado. A previa SAP usa um gateway Node local separado.
  Nenhuma configuracao GGF funcional esta persistida como cadastro SAP nativo.
- `RevaluationPreview`/`MaterialRevaluationPayload` sao previas com bloqueios.
  O preco medio e o FIFO de **cenario tecnico** foram homologados em documentos
  separados, nao como fechamento GGF real. `FifoProductionTrace` distingue
  camada aberta de parcela consumida, mas a atribuicao geral de multiplas
  camadas, transferencias e destinos da saida ainda nao existe.
- `CLOSE`, `CLINE`, `CLAIM`, `CVERS` guardam estado, linhas, reivindicacao e
  versao. `PostingHash` e `GgfClosingIntegrity` protegem o conteudo funcional
  V1. O coordenador/reconciliador pressupoe **um** `MaterialRevaluation` e
  **um** `TransId`; nao modela uma etapa separada de CPV. A interface e
  `ClosingSession.confirm()` seguem bloqueadas para contabilizacao.

## Inventario e decisao por componente

As categorias indicam o destino **na V2**. "Descontinuar" significa retirar um
comportamento do novo fluxo depois da migracao; nao apagar arquivos, registros
ou evidencias V1 nesta etapa.

| Componente atual ou necessario | Classe | Decisao e motivo |
| --- | --- | --- |
| `core/service/ServiceLayerClient`, sessao, erros e guarda de escrita | **1. REUTILIZAR SEM ALTERACAO** | Transporte e fronteira de autenticacao; V2 nao precisa de outro cliente. |
| `MappedGgfSource` e controles de paginacao/contagem | **1. REUTILIZAR SEM ALTERACAO** | Serve de coletor fail-closed; novas fontes entram por definicoes/mapeadores, nao por bypass. |
| `SapB1ReadMapping` e `SapB1OrderAudit` | **2. REUTILIZAR COM REFATORACAO** | Diagnosticos e trilha de OP permanecem; extrair consultas/normalizacoes comuns e distinguir leitura diagnostica de snapshot de fechamento. |
| `SapGgfCalculationSource` | **2. REUTILIZAR COM REFATORACAO** | Preservar fontes comprovadas; remover recorte fixo setembro/OPs apenas apos novos filtros, contagens e elegibilidade homologados. |
| `engine/allocation.ts` (apportion, quatro criterios, arredondamento) | **1. REUTILIZAR SEM ALTERACAO**, inicialmente | Motor validado recebe um pool normalizado; nao mudar sua matematica sem caso comprovado. Testes V1 continuam referencia de regressao. |
| `engine/types.ts` e `sourceEvidence.ts` | **2. REUTILIZAR COM REFATORACAO** | Acrescentar contrato explicito de custo real, absorcao, saldo e provas; nao mascarar saldo residual como `AccountBalance.amount` contabil. |
| `GgfRepository`, catalogo e configuracao V1 | **2. REUTILIZAR COM REFATORACAO** | Manter quatro criterios/classificacoes; acrescentar vinculo aprovado entre conta de gasto, origem de absorcao, escopo e vigencia da regra. |
| `DevelopmentGgfRepository` e fixtures `DEV-*` | **1. REUTILIZAR SEM ALTERACAO** | Simulacao fica segregada e rotulada; criar fixtures V2 separadas, sem alterar significado dos exemplos V1. |
| `ClosingSession`, revisoes de consulta e `confirm()` bloqueado | **2. REUTILIZAR COM REFATORACAO** | Orquestrar pool -> rateio -> destinacao; manter invalidacao assincrona e bloqueio de escrita ate homologacao. |
| `SapGgfClosingRepository`, UDOs `CLOSE/CLINE/CLAIM/CVERS` | **2. REUTILIZAR COM REFATORACAO** | Preservar chaves/dados V1; adicionar esquema versionado para pool, destinacao e multiplos vinculos sem reinterpretar campos antigos. |
| Claim por `ClosingId` e estado `POSTING_UNCERTAIN` | **2. REUTILIZAR COM REFATORACAO** | Exclusao unica do fechamento permanece; cada futura perna documental precisa estado, identidade e reconciliacao proprios, sem retry automatico. |
| `PostingHash` e `GgfClosingIntegrity` V1 | **2. REUTILIZAR COM REFATORACAO** | Congelar algoritmo V1 para registros existentes; criar hash V2 com versao de esquema e todas as entradas economicas/documentos pretendidos. |
| `SapGgfClosingVersionRepository` | **2. REUTILIZAR COM REFATORACAO** | Snapshot historico e bom; `create()` hoje exige exatamente uma `fifoLineage`, insuficiente para fechamento V2 geral. |
| `RevaluationPreview`, `MaterialRevaluationPayload`, `SapRevaluationSource` | **2. REUTILIZAR COM REFATORACAO** | Reusar validacoes de estoque, metodo, contas e payload; calcular efeito **somente da parcela elegivel em estoque** e agregar no escopo real de avaliacao. |
| `FifoProductionTrace`, `FifoRevaluationPreview` | **2. REUTILIZAR COM REFATORACAO** | Preservar linhagem e bloqueios; generalizar por recebimento/camada, saidas e substituicao de camada antes de uso funcional. |
| `SapRevaluationReconciliation`, `GgfPostingCoordinator` | **2. REUTILIZAR COM REFATORACAO** | Leitura/reconciliacao e maquina de estados aproveitaveis, mas suposicao de documento unico nao cobre estoque + parcela consumida. |
| `Closing.view.xml`, `Revaluation.view.xml`, controllers e navegacao UI5 | **2. REUTILIZAR COM REFATORACAO** | Manter Horizon, menus e assistente; exibir real/absorvido/saldo, bloqueios e duas destinacoes sem confundir diagnostico com fechamento pronto. |
| `exportCsv`, `revaluationExport` | **2. REUTILIZAR COM REFATORACAO** | Preservar CSV seguro contra formulas; acrescentar composicao contabil, reconciliacoes, destinos e vinculos, com versao de layout. |
| Testes V1, Playwright e roteiros de homologacao | **1. REUTILIZAR SEM ALTERACAO**, como regressao | Nao reescrever o historico; adicionar cenarios V2 e manter provas SAP tecnicas identificadas como tal. |
| Interpretar saldo bruto de conta como todo GGF ainda a absorver | **3. DESCONTINUAR** no caminho V2 | Ignora parcela ja aplicada e pode duplicar custo. A memoria V1 nao deve ser renomeada para sugerir saldo liquido. |
| Somar `currentCost + allocated` como custo SAP pronto para reavaliacao | **3. DESCONTINUAR** como decisao contabil | Hoje e so resultado matematico por OP; metodo/estoque/escopo de avaliacao governam o documento real. |
| Conta de validacao tecnica, OPs fixas e `source=sap-read` como fechamento operacional | **3. DESCONTINUAR** como caminho produtivo | Manter para reproducao tecnica, sem conta GGF padrao nem fallback de demo. |
| Extrator/conciliador de custo real e absorcao previa | **4. NOVO DESENVOLVIMENTO** | Exige mapeamento contabilidade -> OP/recurso -> conta/filial/dimensoes e exclusao de movimentos internos/fechamentos anteriores. |
| Pool residual V2 e controle de dupla absorcao | **4. NOVO DESENVOLVIMENTO** | Contrato proprio com `real - absorvido = saldo`, justificativas por linha e comparacao independente. |
| Destinacao estoque/consumido/outras saidas e proposta CPV | **4. NOVO DESENVOLVIMENTO** | Rastreamento, politica contabil e proposta separada; nao tratar toda saida como CPV nem toda producao como estoque atual. |
| Persistencia de configuracao funcional SAP e novos vinculos documentais | **4. NOVO DESENVOLVIMENTO** | UDO/metadados aditivos, aprovados e migrados sem alterar ou sobrescrever fechamento V1. |

## Arquitetura alvo V2

```text
1. Leitura SAP completa, datada e escopada
   |-- gastos reais elegiveis (razao, origem, conta, filial/dimensoes)
   |-- absorcao padrao ja apropriada (documentos/OP/recurso/conta)
   |-- OPs, recebimentos, bases e movimentacao posterior
   `-- estoque, custo/camadas, determinacao contabil
2. Reconciliacao independente por conta + escopo
   -> PoolResidualV2 {real, absorvido, saldo, evidencias, regra, bloqueios}
3. Motor de rateio existente (somente saldo aprovado, quatro criterios)
   -> memoria por conta/OP, conservando sinal e centavos
4. Destinacao por OP/recebimento/item/deposito/metodo
   -> estoque comprovado | consumo com destino comprovado | nao atribuivel
5. Propostas separadas: reavaliacao de estoque | ajuste contabil de saida
   -> validacao, hash V2, claim, versoes, reconciliacao por documento
6. Fechamento persistido e relido; UI/CSV mostram a mesma memoria
```

Contratos e invariantes propostos (valores em centavos, sinais preservados):

- Cada combinacao aprovada de empresa, periodo, filial, dimensoes, moeda e
  natureza de gasto possui `Real`, `Absorvido` e `Saldo = Real - Absorvido`.
  Guardar origem/TransId/linha de **ambos** os lados. A soma de saldos por
  conta deve reconciliar com a soma de lancamentos selecionados e com controle
  independente; nao converter ausencia de prova em zero. Creditos, estornos,
  reclassificacoes e fechamento anterior precisam de politica explicita.
- `TotalSaldoElegivel = TotalRateadoPorOP`, com ajustes de arredondamento
  rastreaveis. Percentual configurado incide sobre o **saldo elegivel** segundo
  politica aprovada; nunca aplicar o percentual ao custo real e subtrair uma
  absorcao integral sem uma regra expressa. Se houver parcela nao submetida ao
  rateio, ela permanece explicitamente `NaoRateada` e concilia no header.
- Para cada OP, `GGF_OP = GGF_estoque + GGF_consumido + GGF_nao_atribuivel`.
  Apenas quantidade/camada remanescente comprovada pode compor estoque. Saida
  comprovada nao implica CPV: venda, consumo em outra OP, transferencia,
  perda e ajuste de inventario tem destinos distintos. `NaoAtribuivel` bloqueia
  fechamento definitivo, nao vira CPV presumido.
- A proposta de reavaliacao e por escopo de avaliacao SAP (por exemplo,
  item/deposito para custo medio quando assim configurado, camada para FIFO),
  **nao** uma linha de preco por OP. Seu efeito estimado deve conciliar com a
  parcela a estoque; qualquer diferenca de precisao ou estoque concorrente
  bloqueia. A proposta contabil da parcela consumida so existe apos definir
  conta, contrapartida, dimensoes, documento e regra de reversao.
- `TotalSaldoElegivel = TotalRateado = TotalEstoque + TotalConsumido +
  TotalNaoAtribuivel` deve ser exibido em cada versao. `TotalContabilizado`
  e conciliado por **documento e perna**, nunca inferido apenas do hash ou
  da igualdade matematica interna.

O item `bis_Standard` nao recebe automaticamente a mesma estrategia de
reavaliacao usada em custo medio ou FIFO. A [documentacao SAP](https://help.sap.com/docs/SAP_BUSINESS_ONE/68a2e87fb29941b5bf959a184d9c6727/451fa75c8ffb4a2fe10000000a11466f.html)
distingue os metodos; a [documentacao de custeio da OP](https://help.sap.com/docs/PRODUCT_ID/68a2e87fb29941b5bf959a184d9c6727/689975f9caea438ba98206fce1573bcb.html)
mostra que diferencas de producao podem seguir variancia propria. Manter
bloqueado ate homologacao especifica. A prova FIFO atual cobre camada tecnica
aberta e consumo parcial; nao prova CPV automatico. Para custo medio, uma
mudanca de preco afeta o saldo do escopo, nao apenas a OP escolhida.

### Persistencia e compatibilidade

- Preservar `CLOSE/CLINE/CLAIM/CVERS` e todos os dados ja gravados. Associar
  cada fechamento a `schemaVersion`/`hashVersion`: leitor V1 verifica com o
  algoritmo V1 congelado; escritor V2 grava apenas contratos V2. Nunca
  recalcular um `POSTED` V1 com novos campos/defaults para faze-lo passar.
- Planejar metadados **aditivos** para pool real/absorvido, memoria de destino
  e vinculos `ClosingId -> [tipo, etapa, DocEntry, DocNum, TransId, status]`.
  Definir tamanho, paginacao, versao e permissoes antes da instalacao; avaliar
  UDO novo versus campos/linhas existentes com migracao testada. O atual
  `U_SapDocEntry/U_SapTransId` continua legado, nao comporta reavaliacao +
  outro documento. `CVERS.create()` deve aceitar snapshot V2 geral sem exigir
  uma unica `fifoLineage`.
- Um claim permanente por `ClosingId` continua impedindo dois executores.
  Como nao existe transacao SAP unica entre documentos e UDOs, guardar
  intencao/resultado por etapa, reconciliar cada documento em nova leitura e
  manter `POSTING_UNCERTAIN` para qualquer resultado ambiguo. Nao liberar
  retry automatico nem usar `Reference1`, `Comments` ou `JournalMemo` como
  identidade principal. `SAP_METADATA_UNAVAILABLE` continua fail-closed.
- Incluir no hash V2 regra/versao, universo de documentos e filtros, custo
  real, absorcao, saldo, percentuais, bases/OPs, destinacao, contas e payloads
  propostos. Excluir apenas campos realmente volateis. Versoes finalizadas
  permanecem imutaveis; integridade relida do SAP, com incidente administrativo
  em divergencia. Hash protege contra alteracao posterior, nao prova a
  classificacao economica de origem.

## Riscos e dependencias

| Risco/dependencia | Tratamento exigido antes de liberar a fase correspondente |
| --- | --- |
| Dupla absorcao de recursos e contas | Mapear componentes de tarifa, contas de apropriacao e lancamentos por origem; conciliar debito/credito e excluir apenas o que foi comprovadamente absorvido. O diagnostico de [setembro/2026](GGF-FUNCTIONAL-DIAGNOSTIC.md) mostra risco em `4.01.01.04.07`, nao uma regra aprovada. |
| Custo real/absorvido sem correspondencia 1:1 | Aprovar chave de conciliacao, ajustes, centros, filiais, moeda, periodizacao e eventual rateio entre contas; bloquear lacunas e sobreposicoes. |
| Periodo e base | Setembro/2026 foi mes nao fechado na validacao; leituras e estoque mudam. Horas reais nao comprovadas; nao substituir por planejadas. Quantidades so somam quando comparaveis. |
| Estoque versus consumido | Custo medio mistura origens; FIFO exige linhagem por camada; transferencias e multiplos recebimentos podem romper atribuicao simples. Releitura imediatamente antes de futura contabilizacao e obrigatoria. |
| CPV nao e destino universal | Precisar de prova do tipo de saida e aprovacao contabil para venda, uso interno, perda e outros movimentos. Nenhum Journal Entry geral e aprovado aqui. |
| Integridade de metadados SAP | `FBO_GGF_CVERS` teve exposicao intermitente na Service Layer; seguir [registro de estabilidade](SAP-UDO-SERVICE-LAYER-STABILITY.md). Nao migrar nem liberar escrita enquanto a dependencia nao estiver estavel. |
| Compatibilidade de hashes/UDOs | Mudanca de algoritmo/campos pode invalidar POSTED historico; exigir leitor versionado, migracao aditiva e teste de releitura em sessao nova. |
| Homologacao limitada de documento | Media movel e FIFO foram provas tecnicas pontuais. Nao extrapolar para multiplos itens/depositos/camadas, standard, serie/lote, CPV ou contabilizacao GGF geral. |

## Sequencia de implementacao proposta

1. **Congelar contratos V1 e criterios de aceite V2.** Inventariar registros
   persistidos, hashes e formatos; aprovar com contabilidade definicao de
   gasto real, absorcao anterior, escopo, saldos negativos e destino de cada
   saida. Nenhuma alteracao no motor nesta fase.
2. **Leitura e conciliacao do pool residual.** Criar adaptadores somente de
   leitura para real e absorvido com evidencia por linha SAP, contagem e
   conferencias independentes. Reexecutar em um periodo controlado, sem
   classificar conta automaticamente.
3. **Compor V2 sobre `allocate`.** Introduzir `PoolResidualV2` e adaptacao
   explicita para o motor; memoria mostra real, absorvido e saldo antes do
   rateio. Golden tests garantem que a matematica V1 nao mudou.
4. **Destinar por OP/estoque/saida.** Fazer rastreio por recebimento e metodo;
   usar `FifoProductionTrace` e previas atuais como ponto de partida. Bloquear
   parcelas sem destino provado. Aprovar politica contabil da parcela consumida.
5. **Persistir e apresentar V2 em leitura/simulacao.** Metadados aditivos,
   configuracao SAP versionada, header/linhas/pool/destino, hash V2, claim,
   integridade, CSV e telas UI5. Manter o modo DEV segregado e o botao de
   contabilizacao desligado.
6. **Homologar cada perna documental separadamente.** Apenas apos regras,
   permissoes, Service Layer estavel, testes de concorrencia e reconciliacao
   independente: estoque por metodo e depois ajuste da parcela consumida.
   Liberacao de escrita requer autorizacao especifica futura, fora deste plano.

## Impacto nos testes existentes

- **Preservar** suites de `allocation`, `rateioEngine`, `sourceEvidence`,
  `mappedSource`, `workflow`, `sapCalculationSource`, `closingLifecycle`,
  `sapClosingRepository`, `fifo*`, `materialRevaluationPayload` e Playwright
  de navegacao/bloqueios. Elas protegem invariantes V1, nao validam V2.
- **Adicionar** testes independentes para `real - absorvido`, sinais,
  reversoes, estornos, documento ja apropriado, conta compartilhada, filial,
  dimensoes, moeda, leitura incompleta e periodo alterado durante a captura.
  Conciliar linhas SAP por TransId/Line_ID e por um controle externo ao proprio
  motor; soma distribuida zero nao basta.
- **Adicionar** matrizes por criterio de rateio usando **saldo residual**,
  incluindo zero, negativo, percentual, multiplas contas, bases ausentes e
  arredondamento; comparar a saida do motor com calculo independente.
- **Adicionar** testes de destinacao: producao ainda em estoque, totalmente
  consumida, parcial, estoque compartilhado, transferencia, saida sem destino,
  varias camadas/recebimentos, custo medio, FIFO, standard bloqueado e mudanca
  concorrente do estoque. Verificar conservacao por OP e global.
- **Adicionar** testes de persistencia/seguranca V1+V2: hash antigo continua
  valido, novo hash muda com cada componente economico, versoes anteriores
  permanecem, claim concorrente, falha entre duas pernas, timeout apos cada
  envio, reconciliacao ambigua, `POSTING_UNCERTAIN`, tampering de pool/linhas/
  vinculos e metadata indisponivel. Playwright cobre os estados reais versus
  desenvolvimento e nunca habilita contabilizacao por acidente.

**Marco de aceite da arquitetura:** um fechamento V2 simulado deve explicar e
reproduzir cada centavo desde os lancamentos reais/absorvidos ate OP e destino,
com diferenca zero e bloqueios visiveis para prova ausente. Isso ainda nao
autoriza reavaliacao, ajuste de CPV ou fechamento contabil no SAP.
