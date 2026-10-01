# GGF V2 Posting Orchestration

## Escopo desta etapa

Esta entrega implementa a coordenacao de dominio e os testes offline do ciclo de documentos. Ela nao habilita contabilizacao na interface e nao cria um gateway SAP financeiro. O orquestrador exige que um adaptador futuro releia fechamento, PostingPlan, integridade, metadata e claim diretamente do SAP em cada operacao. Nenhum documento financeiro foi enviado nesta etapa.

O PostingPlan tecnico persistido na SBODEMOBR2 permanece `BLOCKED`, com `TotalBlocked <> 0` e payloads nulos. Ele e deliberadamente inelegivel; nao pode ser promovido para demonstracao.

## Pre-condicoes verificadas

`GgfPostingOrchestrator.prepare()` aceita somente um bundle relido do SAP quando:

- identidade do fechamento e do plano, empresa, versao e hash correspondem;
- integridade do fechamento nao e `INTEGRITY_VIOLATION` e metadata esta disponivel;
- o fechamento esta `READY_TO_POST`;
- o PostingPlan esta `VALIDATED`, com hash recalculado igual ao hash persistido;
- `TotalBlocked`, diferenca total e diferenca contabil sao zero;
- todas as linhas/documentos estao aptos, com contas de debito e credito;
- o metodo de avaliacao de cada linha MaterialRevaluation esta explicitamente homologado;
- cada documento fecha com o total de suas linhas.

Tambem confere `MaterialRevaluation = TotalStock`, `JournalEntry.CPV = TotalCpv` e `JournalEntry.Closing = TotalStock + TotalCpv`, em centavos inteiros.

O payload permanece nulo no snapshot imutavel. O gateway constroi uma proposta por documento somente depois dessas verificacoes. A requisicao sanitizada e a resposta sanitizada sao mantidas na trilha de execucao; cookies, tokens, sessoes, senhas e autorizacoes sao removidos.

## Estados e recuperacao

Fluxo pretendido:

```text
READY_TO_POST -> CLAIM -> POSTING -> POSTED
                              |
                              +-> POSTING_PARTIAL -> reconciliar -> POSTED
                              +-> POSTING_UNCERTAIN -> reconciliar -> POSTED
                              +-> FAILED
```

`FAILED` so e gravado para rejeicao SAP definitiva antes de qualquer documento criado. Falha definitiva depois de um documento conciliado e `POSTING_PARTIAL`. Timeout, resposta incompleta, leitura incompleta ou multiplos candidatos sao `POSTING_UNCERTAIN`.

Depois de claim existente, o orquestrador nao chama `post()` novamente. A reconciliacao pode marcar documentos existentes, mas documentos ainda nao enviados permanecem pendentes; a execucao fica parcial e exige continuacao explicita, fora desta entrega. Uma busca incompleta ou ambigua nunca prova ausencia.

## Ordem e conciliacao

Os documentos aptos sao ordenados pelo `order` persistido no PostingPlan. Documentos `NOT_REQUIRED` sao ignorados. Cada request e preparado contra uma linha exata do plano, depois submetido individualmente e conciliado antes do proximo. A implementacao abstrata exige identidade SAP (DocEntry, DocNum, TransId) e exatamente um candidato compativel.

Familias reconhecidas pelo plano:

1. `MaterialRevaluation`
2. `JournalEntry.CPV`
3. `JournalEntry.Closing`

Nao se fabricam documentos vazios. Um efeito criado nunca e apagado nem recriado automaticamente.

## Persistencia SAP ainda necessaria

O contrato `GgfPostingOrchestrationStore` documenta leitura autoritativa, claim, transicao compare-and-set do header e snapshots da execucao. Na Fase 7B, claim passa a usar a identidade composta `ClosingId + ClosingVersion + PostingPlanVersion + PostingHash`, com `ExecutionId` deterministico. O ledger foi separado em `FBO_GGF_PEXEC` e `FBO_GGF_PDOC`; veja [GGF-V2-POSTING-EXECUTION-LEDGER.md](GGF-V2-POSTING-EXECUTION-LEDGER.md). Claims antigas por ClosingId permanecem intactas e bloqueiam uma tentativa nova ate reconciliacao explicita.

Foi executado somente o plano de metadata em leitura na `SBODEMOBR2`: 48 acoes aditivas para os novos campos e os dois UDOs, sem divergencias. Nenhuma acao foi instalada. A prova persistente SAP esta aguardando aprovacao da estrutura e instalacao controlada; nenhum POST financeiro foi executado.

O `SapGgfClosingRepository` e o `SapGgfPostingPlanRepository` existentes nao sao combinados implicitamente: o primeiro suporta uma ligacao simples de MaterialRevaluation; o segundo guarda snapshots bloqueados e imutaveis. O orquestrador novo nao chama nenhum deles para escrita financeira.

## Prova controlada pendente

Uma prova real exige um ClosingId funcional novo e um PostingPlan `VALIDATED` persistido, com uma unica familia documental apta. O cenario tecnico `TECH-SBODEMOBR2-202609` nao serve. Nao foi inferida conta, item, deposito, valor ou classificacao para uma nova transacao. A primeira transacao deve ser escolhida apos leitura e exibicao do payload exato, contas de determinacao, impacto contabil esperado e regra de reversao aprovada.

Em 01/10/2026 foi feita releitura HTTPS somente GET do item tecnico anterior e do documento `MaterialRevaluation(25)`: `F1GGF26H01` segue em `bis_MovingAverage`, com 1 UN no deposito 01 a custo local 13; o documento 25 permanece vinculado ao diario 2278 e registrou aumento de 1. Essa leitura nao cria um novo cenario. Repetir valor 1 no mesmo item alteraria novamente seu valor/custo atual; o comprovante anterior foi exclusivamente tecnico e nao e fonte de saldo GGF. Por isso nenhum segundo documento foi enviado.

No estado atual nao ha prova de POST do orquestrador, Journal Entry CPV ou Journal Entry de fechamento. A homologacao de MaterialRevaluation de preco medio anterior nao prova este fluxo orquestrado. Nenhum botao de contabilizacao deve ser exposto.

## Testes

`test/ggf/ggfPostingOrchestrator.test.ts` cobre plano bloqueado, hash divergente, claim existente, POST ordenado, timeout, reconciliacao, falha antes/depois de documento e fechamento finalizado. Os testes usam stores/gateways em memoria e explicitamente nao sao evidencias de integracao SAP.
