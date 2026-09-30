# GGF: homologacao controlada de MaterialRevaluation

## Alcance

Em 28/09/2026, na empresa de testes SBODEMOBR2, foi executada **uma** reavaliacao real de estoque, pelo metodo `P` (alteracao de preco) em item de media movel. O objetivo foi comprovar a criacao Service Layer, efeito no estoque/custo e lancamento contabil com valor tecnico controlado de R$ 1,00. Esse valor nao veio de conta contabil de GGF nem representa fechamento funcional aprovado. Nenhuma OP 76, 77 ou 79 foi usada ou alterada.

O fluxo de uso geral do GGF permanece bloqueado na interface. O script de homologacao aceita somente este item, esta empresa, esta referencia e uma linha; registra uma intencao local antes da tentativa de POST. Esta prova autoriza a conclusao tecnica **apenas** para media movel, estoque positivo, avaliacao por deposito e `RevalType=P` neste cenario. Nao libera lote/serie, FIFO, preco padrao, saldo negativo ou contabilizacao automatica de fechamentos.

## Cenario criado no SAP

| Objeto | Identidade / evidencia |
| --- | --- |
| Item acabado | `Items('F1GGF26H01')`, descricao `FactoryOne GGF homologacao controlada`, grupo 100, inventariavel, `bis_MovingAverage`, UN, sem lote/serie. Criado com estoque zero. |
| Lista tecnica | `ProductTrees('F1GGF26H01')`: 1 unidade do recurso `R300011`, Empilhadeira, custo cadastrado R$ 12,00, consumo retroativo. |
| Ordem | `ProductionOrders(212)`, numero 82, planejada 1 UN, liberada, recebida 1 UN e encerrada. |
| Consumo direto | `InventoryGenExits(86)/0`, recurso `R300011`, base OP 212, valor R$ 12,00, `TransNum=2274`. |
| Recebimento | `InventoryGenEntries(116)/0`, numero 74, base OP 212, 1 UN no deposito 01, R$ 12,00, `TransNum=2275`. |
| Deposito/filial | `Warehouses('01')`, `BusinessPlaceID=1`, ativo. |

O SAP rejeitou duas tentativas de criar a OP sem o fluxo requerido: primeiro exigiu lista tecnica (`OWOR.ItemCode`), depois exigiu status inicial Planejada (`OWOR.Status`). A lista tecnica foi criada e somente entao a OP 82 foi gerada. Duas tentativas de recebimento foram rejeitadas porque `TaxDate` e `DocumentLines.ItemCode` devem ficar vazios quando o documento referencia uma OP. As rejeicoes foram HTTP 400 e **nao criaram** OP/recebimento parcial; a ausencia foi conferida antes de cada nova tentativa. Requisicoes e respostas de preparacao, sem credenciais, estao no [registro local do cenario](../.local/ggf/material-revaluation-homologation-F1H2609281.json).

## Estoque elegivel e custo inicial

O item foi criado com 0 UN. A [varredura direcionada](../.local/ggf/material-revaluation-movements-F1H2609281.json) percorreu 14 colecoes de documentos desde 28/09/2026, ate o fim da paginacao, conciliando cada numero de cabecalhos com um `/$count` independente. O unico movimento encontrado para `F1GGF26H01` foi o recebimento 116/0 de 1 UN, `BaseType=202`, `BaseEntry=212`, `WithoutInventoryMovement=tNO`. A releitura de `Items` mostrou 1 UN global e 1 UN no deposito 01, sem lote/serie. Assim, para este item novo e isolado, a unidade recebida da OP 82 e a unidade que permanecia em estoque antes do POST. A leitura nao constitui bloqueio transacional; por isso saldo e custo foram relidos imediatamente antes do envio.

| Grandeza antes | Valor | Fonte |
| --- | ---: | --- |
| Quantidade elegivel e saldo atual | 1 UN | Recebimento 116/0 + movimentos conciliados + `Items.ItemWarehouseInfoCollection('01').InStock` |
| Metodo | Media movel | `Items.CostAccountingMethod=bis_MovingAverage` |
| Custo direto da OP | R$ 12,00 | Recurso no `InventoryGenExits(86)/0`; concilia com `InventoryGenEntries(116)/0.LineTotal` |
| Custo atual por unidade | R$ 12,00 | `Items.ItemWarehouseInfoCollection('01').StandardAveragePrice` |
| Valor do estoque | R$ 12,00 | 1 UN x R$ 12,00 |

`CompanyService_GetAdminInfo` confirmou inventario permanente e avaliacao por deposito. `Items.AvgStdPrice` global retornou zero e **nao** foi usado como custo do deposito.

## Valor tecnico e memoria

Foi autorizado um valor de teste de **R$ 1,00** para a unica OP elegivel. Nao foi gerado saldo contábil ficticio nem cadastrada conta GGF padrao. A memoria tecnica, separada da apuracao funcional, e:

```text
Valor controlado:              100 centavos
Percentual aplicado:           100%
Valor submetido:               100 centavos
Base OP 82:                    1 UN recebida e remanescente
Base total:                    1 UN
Participacao OP:               1 / 1 = 100%
GGF tecnico OP 82:             100 centavos
GGF unitario:                  R$ 1,00 / 1 UN = R$ 1,00
Custo atual:                   R$ 12,00
Custo ajustado proposto:       R$ 13,00
Valor estoque esperado:        1 UN x R$ 13,00 = R$ 13,00
Variacao esperada:             R$ 13,00 - R$ 12,00 = R$ 1,00
```

O `previewRevaluation` aprovado calculou `currentCost=12.000000`, `unitGgf=1.000000`, `adjustedCost=13.000000` e `estimatedTotal=1.00`. O simulador `simulateMaterialRevaluation` retornou **APTO** com as evidencias do item, OP, recebimento, saldo, contas, periodo e serie. A [captura do preflight](../.local/ggf/material-revaluation-preflight-F1H2609281.json) inclui a memoria, provas, payload e hora da leitura. A [documentacao da previa anterior](GGF-INVENTORY-REVALUATION.md) permanece separada, com bloqueios para as OPs 76/77/79.

## Contas, periodo e serie

O resolvedor do proprio SAP `CompanyService_GetAdvancedGLAccount` retornou, para item `F1GGF26H01`, deposito 01, 28/09/2026:

| Tipo de conta | Codigo | Uso comprovado |
| --- | --- | --- |
| `iatInventory` | `1.01.02.01.01` | Estoque, debitado no diario real. |
| `iatGLIncrease` | `5.03.01.01.04` | Contrapartida do aumento, creditada no diario real. |
| `iatGLDecrease` | `5.03.01.01.04` | Determinada pelo SAP, mas nao utilizada neste ajuste positivo. |

As duas contas envolvidas estavam ativas, desbloqueadas para lancamento manual, sem obrigatoriedade de projeto e nao exclusivas de centro de custo (`ChartOfAccounts`). O metodo de determinacao avancada estava ligado. `iatIncreasing` e `iatGLIncrease` sao tipos distintos; a reavaliacao usou a segunda conta, conforme o diario. [SAP: contas de determinacao de estoque](https://help.sap.com/docs/SAP_BUSINESS_ONE/87e1767ca7584b8f8d60775347637b07/d613bdf34eb94886b62e300a72403b31.html).

`CompanyService_GetFinancePeriod` confirmou periodo 179 (`2026-09`) com `ltUnlocked`, `Locked=tNO` e datas contabil/fiscal abrangendo 28/09. `SeriesService_GetDefaultSeries` retornou serie 25, desbloqueada, documento 162. Essas consultas sao acoes HTTP POST **sem criacao de documento**; apenas o POST de `MaterialRevaluation` produziu reavaliacao. [Referencia da Service Layer](https://help.sap.com/doc/056f69366b5345a386bb8149f1700c19/10.0/en-US/Service%20Layer%20API%20Reference.html).

## Requisicao unica

Endpoint: `POST /b1s/v2/MaterialRevaluation`, HTTPS com TLS verificado, JSON autenticado pela sessao local. Payload exato enviado:

```json
{
  "DocDate": "2026-09-28",
  "TaxDate": "2026-09-28",
  "Series": 25,
  "RevalType": "P",
  "Reference1": "F1H2609281",
  "Comments": "FactoryOne GGF homologacao F1H2609281",
  "JournalMemo": "FactoryOne GGF homologacao F1H2609281",
  "MaterialRevaluationLines": [
    {
      "ItemCode": "F1GGF26H01",
      "WarehouseCode": "01",
      "Price": 13,
      "RevaluationIncrementAccount": "5.03.01.01.04"
    }
  ]
}
```

A [captura da chamada](../.local/ggf/material-revaluation-post-F1H2609281.json) registra requisicao, resposta, HTTP **201**, inicio/fim, `DocEntry=25`, `DocNum=5`, `TransNum=2278`. O script registrou `POST_INTENT` antes do envio. Uma segunda chamada para o mesmo fechamento foi barrada **antes de abrir sessao SAP**. Nenhum outro `MaterialRevaluation` foi submetido.

## Resultado relido

| Conferencia | Esperado | Encontrado no SAP |
| --- | ---: | ---: |
| Saldo no deposito 01 | 1 UN | 1 UN |
| Custo por unidade | R$ 13,00 | R$ 13,00 |
| Valor do estoque | R$ 13,00 | R$ 13,00 |
| Aumento do estoque | R$ 1,00 | `MaterialRevaluation(25)/0.RevalAmountToStock=1.00` |
| Diario | Debito 1,00 / credito 1,00 | `JournalEntries(2278)`: debito estoque `1.01.02.01.01` 1,00; credito `5.03.01.01.04` 1,00; filial 1, dimensoes vazias |

O documento retornou `RevalType=P`, serie 25, `ActualPrice=12`, `Price=13`, `OnHand=1` e `TransNum=2278`. Portanto **valor controlado = aumento do estoque = efeito contabil = R$ 1,00**. A [verificacao independente apos o POST](../.local/ggf/material-revaluation-verify-F1H2609281.json) relê documento, item, diario, OP, recebimento e consumo; nao usa o motor para afirmar a conciliacao. OP 82 permaneceu encerrada com 1 UN concluida; o custo historico do recebimento 116/0 e do recurso no documento 86/0 permaneceu R$ 12,00. A reavaliacao mudou o custo/valor do estoque atual, **nao reescreveu o custo historico da OP**. [SAP: efeito de reavaliacoes no relatorio de inventario](https://help.sap.com/docs/SAP_BUSINESS_ONE/87e1767ca7584b8f8d60775347637b07/63b18de9063b43268845eafebb21625f.html?locale=en-US&state=PRODUCTION&version=10.0).

### Divergencia: Reference1

O campo `Reference1` estava no JSON aceito com HTTP 201, mas `MaterialRevaluation(25).Reference1` voltou **null**. As linhas do diario tambem nao receberam essa referencia. `Comments` e `JournalMemo` conservaram `F1H2609281`; um GET filtrado por `Comments` encontrou exatamente o documento 25. Assim, a trilha desta homologacao usa **ID local + Comments + DocEntry + TransNum**. Nao se pode afirmar que `Reference1` e um identificador persistente nesse contrato apenas por constar no metadata. A causa de sua omissao ainda precisa ser entendida antes de escolher o vinculo definitivo de producao. Nenhuma segunda reavaliacao foi usada para investigar o campo.

## Idempotencia e limites

O registro ignorado pelo Git guarda `closingId=F1H2609281`, versao 1, estados `POST_INTENT`/`POSTED`, request, HTTP status, `DocEntry=25`, `DocNum=5`, `TransNum=2278` e hora. Um lock atomico local impede duas execucoes simultaneas deste script; um marcador de intencao impede retry cego apos timeout; antes da escrita ha busca remota pela marca em `Comments`. O POST nao e exposto pelo gateway nem pelo botao da interface.

Essa protecao e suficiente para esta homologacao local identificada; **nao** substitui persistencia nativa e unicidade no SAP para o fechamento de clientes. `Comments` nao e chave unica garantida e pode ser editavel. Para automatizar, ainda sao necessarios um identificador nativo de fechamento/versao, vinculo persistente ao DocEntry, transicao de status atomica ou reconciliavel e processo explicito de estorno/reabertura. Em caso de falha de rede apos `POST_INTENT`, consultar SAP por marca e documentos antes de qualquer nova tentativa; nunca repetir automaticamente.

Este ensaio nao valida conta funcional de GGF, criterio de rateio, recuperacao de GGF sobre produto vendido, politica de estoque compartilhado, FIFO, preco padrao, lote/serie, custo por empresa nem comportamento com saldo negativo. As OPs 76/77/79 e seus bloqueios permanecem como antes. A Service Layer comprovou o efeito do `Price Change` para o item controlado, sem autorizar contabilizacao geral do FactoryOne.

## Reproducao e verificacoes

Os scripts de preparacao estao em `scripts/ggf-homologation-scenario.mjs`; a leitura de movimentos em `scripts/ggf-homologation-movements.mjs`; o preflight, a tentativa unica e a verificacao em `scripts/ggf-homologation-revaluation.mjs`. Todos usam `.env` local ignorado pelo Git; nao gravam senha/cookie. O cenario **ja foi contabilizado**. Para revisar agora, abra os artefatos vinculados acima ou execute apenas a verificacao de leitura:

```bash
node scripts/ggf-homologation-revaluation.mjs verify
```

`post` e bloqueado pelo estado existente; nao remova o registro local nem altere o identificador para repetir a experiencia. A implantacao no Web Client nao foi feita e o botao de contabilizacao permanece desabilitado.

Verificacoes locais desta etapa: releitura `verify` conciliada; 413 testes unitarios em 29 arquivos; `tsc --noEmit` sem erros; build MTA concluido; 4 testes Playwright da previa aprovados, incluindo desktop, mobile, ausência de fallback SAP e URL de producao. O build emitiu apenas um aviso de *clock skew* do sistema de arquivos apos gerar o MTAR. Os JSON de evidencia ficam em `.local/ggf/`, e `.env`/`.local` sao ignorados pelo Git; nenhum segredo de sessao foi incorporado aos scripts, testes ou documento.
