# GGF V2 Posting Execution Ledger

## Escopo e limite desta etapa

A Fase 7B adiciona identidade financeira composta, ledger SAP dedicado e recuperacao fail-closed do orquestrador. Nenhum gateway financeiro Service Layer foi conectado para escrita e nenhum MaterialRevaluation ou Journal Entry foi enviado. O estado do ledger e consultado diretamente do SAP; `localStorage` nao participa da autoridade da execucao.

A instalacao dos novos metadados foi deliberadamente adiada. A propria migracao exige uma aprovacao da estrutura antes de qualquer alteracao SAP. O planejamento real foi somente de leitura em `SBODEMOBR2`: versao GGF 4, 48 acoes aditivas, zero divergencias detectadas. As acoes sao duas UDTs, 7 campos novos em `FBO_GGF_CLAIM`, os campos de `FBO_GGF_PEXEC` e `FBO_GGF_PDOC`, e os dois registros UDO. Nada foi instalado e nenhuma claim existente foi atualizada.

## Identidade e ExecutionId

A identidade imutavel e a tupla:

```text
ClosingId + ClosingVersion + PostingPlanVersion + PostingHash
```

`ExecutionId` e deterministico: `F1EX` mais 40 caracteres hexadecimais derivados por SHA-256 da tupla canonica. Claims repetidas da mesma identidade convergem para o mesmo `Code`; versoes diferentes produzem IDs diferentes. A releitura compara todos os quatro campos, portanto o ID resumido nao e aceito como substituto da identidade completa.

`FBO_GGF_CLAIM` recebe campos aditivos para `ClosingVersion`, `PostingPlanVersion`, `PostingHash`, `ExecutionId`, `Status`, `CreatedAt`, `UpdatedAt` e `ClaimedBy`. Claims antigas keyed apenas por ClosingId nao sao alteradas nem interpretadas como uma identidade atual. Se uma claim legada aparecer para o ClosingId da tentativa, a criacao nova e bloqueada para reconciliacao administrativa explicita.

## UDOs propostos

| UDO | Responsabilidade | Chave |
| --- | --- | --- |
| `FBO_GGF_PEXEC` | Estado geral e totais da execucao | `ExecutionId` |
| `FBO_GGF_PDOC` | Um documento planejado, estado, request/response sanitizados e historico de tentativas | `ExecutionId + sequencia` |

`PEXEC` mantem identidade, status, inicio/fim, ator, erro sanitizado, quantidade de documentos e totais esperado/enviado/conciliado. `PDOC` mantem tipo/ordem/valor/moeda, dependencias, `RequestHash`, snapshot sanitizado, tentativas, datas, status de conciliacao e DocEntry/DocNum/TransId. Cada linha e keyed deterministicamente e nao pode mudar de identidade, sequencia, familia ou valor planejado por PATCH.

`CLINE` continua sendo auditoria das linhas calculadas do fechamento e `PPLAN` continua sendo snapshot imutavel do plano. Nao sao reutilizados para estado de execucao. A separacao permite mais de um documento e multiplas tentativas sem misturar dominios.

## Estados e recuperacao

Execucao: `READY`, `POSTING`, `POSTING_PARTIAL`, `POSTING_UNCERTAIN`, `POSTED`, `FAILED`, `PAYLOAD_INTEGRITY_VIOLATION`.

Documento: `PENDING`, `SENDING`, `SENT`, `UNCERTAIN`, `RECONCILED`, `FAILED`.

Antes de qualquer futuro envio, a proposta canonica sanitizada recebe SHA-256 e e persistida em `PDOC` como `SENDING`, junto de `AttemptCount` e `AttemptStartedAt`. So depois da releitura do registro persistido o gateway poderia enviar. Retorno de transporte passa por `SENT`, e somente evidencia unica e completa permite `RECONCILED`. Resposta HTTP 201 sozinha nao satisfaz a dependencia do documento seguinte.

`resumeExecution(ExecutionId)` deve abrir nova leitura SAP de fechamento, plano, claim, execucao e documentos; comparar identidade e hashes; e parar no primeiro documento nao conciliado. `PENDING` fica pendente para uma continuacao explicitamente autorizada. `SENDING`, `SENT` e `UNCERTAIN` exigem reconstruir a proposta e comparar `RequestHash`, depois consultar o SAP. Hash divergente torna a execucao `PAYLOAD_INTEGRITY_VIOLATION`. `RECONCILED` nunca e reenviado. `FAILED` exige tratamento administrativo, nao retry implicito. Estado incompleto, paginacao incompleta ou totais divergentes bloqueiam qualquer continuacao.

Documentos dependentes permanecem pendentes enquanto os predecessores nao estiverem reconciliados. A interrupcao entre documento 1 e 2 preserva o primeiro como reconciliado e direciona o segundo para conciliacao; o documento 3 nao inicia.

## Persistencia e seguranca

`SapGgfPostingExecutionRepository` relê contagens independentes, percorre paginas, valida chaves/identidade e compara os totais header/linhas. `SapGgfPostingClaimRepository` usa Code unico por identidade e nunca apaga claims. `SapGgfPostingOrchestrationStore` compoe fechamento, plano, claims e ledger sem introduzir armazenamento local.

Gravacoes UDO em multiplas chamadas HTTP nao sao transacionais. Uma interrupcao entre header e documentos pode deixar inconsistencia; a leitura detecta a divergencia e falha fechada. Nenhum reparo silencioso ou novo POST financeiro e feito. Isso e uma limitacao do modelo Service Layer que precisa ser homologada; se ocorrer em producao, exige conciliacao administrativa.

Payloads e respostas persistidos sao sanitizados para remover senha, cookie, token, sessao e autorizacao. Cookies da Service Layer continuam fora do dominio persistido. Timestamps sao dados operacionais e nao participam de `PostingHash` nem de `RequestHash`.

## Prova tecnica

Os testes offline criam uma execucao tecnica com tres documentos controlados (`RECONCILED`, `UNCERTAIN`, `PENDING`), persistem no store SAP simulado, instanciam outra leitura e comparam os campos reconstruidos. Tambem testam identidade por versao, claim legado, request hash alterado, retomada de timeout, nao reenvio de documento reconciliado e rejeicao de ledger incompleto.

A prova persistente real em `SBODEMOBR2` permanece pendente porque `FBO_GGF_PEXEC` e `FBO_GGF_PDOC` ainda nao existem. Apos aprovacao desta proposta, a instalacao deve ser aditiva, verificar metadados e exposicao em sessoes/nos independentes, preservar as claims atuais, persistir somente a execucao tecnica ficticia e reler os tres documentos em nova sessao. O cenario do plano continua `BLOCKED`; nao pode ser convertido em `READY`.

## Interface

A tela de absorcao tem consulta operacional por `ExecutionId`, somente leitura. Exibe identidade, integridade, status, sequencia, valor, tentativas, hash da requisicao e identidade SAP quando existente. `POSTING_UNCERTAIN` exibe: “Resultado da contabilizacao precisa ser reconciliado antes de continuar.” Nao ha botao de envio, retomada automatica ou contabilizacao.
