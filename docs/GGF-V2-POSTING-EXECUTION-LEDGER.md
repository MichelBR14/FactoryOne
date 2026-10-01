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

## SAP real validation - 2026-10-01

O snapshot sanitizado pre-instalacao foi registrado localmente em `.local/ggf/phase7b-metadata-pre-install.json` (ignorado pelo Git). Para `SBODEMOBR2`, o plano tinha 48 acoes de criacao, zero avisos, zero remocoes, zero renomes e zero alteracoes incompativeis. `FBO_GGF_CLAIM` ja existia com `ApplyAuthorization=tYES` e `CanDelete=tNO`; PEXEC e PDOC ainda nao existiam nem estavam expostos no `$metadata`. O hash SHA-256 do `$metadata` antes da instalacao foi `72a6b05769a28a3472125910f118ad89d01f6d6bb416e63cf95c82ae4104e855`.

As 48 acoes aditivas de metadata foram aceitas pelo Service Layer. A validacao de exposicao em sessao nova falhou e o instalador parou antes de registrar a versao GGF em `FBO_SETUP`. Uma sessao nova independente, roteada para o membro 1, confirmou:

- `UserObjectsMD`: CLAIM, PEXEC e PDOC retornaram HTTP 200; PEXEC e PDOC tinham `ApplyAuthorization=tYES` e `CanDelete=tNO`.
- `$metadata`: HTTP 200, mas manteve o mesmo hash do snapshot pre-instalacao; CLAIM estava exposto, PEXEC e PDOC nao.
- `FBO_GGF_PEXEC/$count`: HTTP 200, count 0.
- `FBO_GGF_PDOC/$count`: HTTP 400.

Resultado operacional: `SAP_METADATA_UNAVAILABLE`. A migracao de metadata nao pode ser considerada homologada, apesar dos registros de UDO persistidos. Nenhuma claim nem execucao de teste foi criada, `resumeExecution()` nao foi executado nesta tentativa e chamadas financeiras reais permaneceram em zero. Nao houve MaterialRevaluation ou Journal Entry. A leitura da execucao na interface e round-trip multi-sessao ficam bloqueados ate a Service Layer publicar PEXEC/PDOC consistentemente em sessoes novas e endpoints.

A excecao TLS local manteve HTTPS cifrado, mas nao autenticou o certificado. Ela nao foi versionada. Testes offline, typecheck e build passaram depois da tentativa; isso nao muda o estado de homologacao do SAP.

## Fase 7C - homologacao isolada do Journal Entry CPV - 2026-10-01

Foi executado exatamente um Journal Entry financeiro em `SBODEMOBR2`, sem MaterialRevaluation, segundo Journal Entry ou contabilizacao em lote. O `ClosingId` tecnico foi `TECH7C-20261001-935FF7551D`, ClosingVersion 4, PostingPlanVersion 1, ExecutionId `F1EX17f80bdb2ef70dfc140528e5d5865affd8143051`. O plano tem `PostingHash` `8a85d883e2ce1593c2df3a1079d1e44afd6b26912f8147a018bcb6c09efeb07b`; o request tem `RequestHash` `9a289a2dfb511edf5596b88f6c29a7a8b4021fe80a85bec1dac132303c92de17`.

Preflight de leitura imediatamente anterior:

- `5.01.01.01.01`: ativa e aceita lancamento manual (`BlockManualPosting=tNO`). O nome atual no SAP e `Custo dos Produtos Vendidos`, diferente do rotulo solicitado `Custo dos Produtos Acabados Vendidos`; o codigo informado pelo usuario foi mantido e validado.
- `5.04.01.01.05`: ativa, aceita lancamento manual; nome SAP `( - ) Transitória Fechamento Mensal`.
- Filial 1 existe e esta habilitada. Todos os indicadores de projeto, regras de distribuicao e contabilidade de custos das duas contas retornaram `tNO`. Nenhuma dimensao foi inventada ou enviada; a releitura das linhas confirmou dimensoes sem valor.
- Moeda local SAP: `R$` (Real), moeda de sistema USD. O payload omitiu moeda estrangeira e informou os valores em moeda local; o SAP calculou tambem USD 0.20 por linha.
- Periodo `2026-10` aberto, sem bloqueio; data do documento 2026-10-01.
- A conexao HTTPS usou a excecao TLS local previamente autorizada. A conexao estava cifrada, mas o certificado expirado nao foi autenticado (`tlsVerified=false`). Nenhuma configuracao de TLS foi versionada.

Payload financeiro enviado (valores em moeda local):

```json
{
  "ReferenceDate": "2026-10-01",
  "DueDate": "2026-10-01",
  "TaxDate": "2026-10-01",
  "Reference": "TECH7C-20261001-935FF7551D",
  "Memo": "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF",
  "JournalEntryLines": [
    { "AccountCode": "5.01.01.01.01", "Debit": 1, "Credit": 0, "BPLID": 1, "LineMemo": "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF" },
    { "AccountCode": "5.04.01.01.05", "Debit": 0, "Credit": 1, "BPLID": 1, "LineMemo": "HOMOLOGAÇÃO TÉCNICA FACTORYONE GGF" }
  ]
}
```

O POST foi aceito. `JournalEntries` retornou `JdtNum=2307`, `Number=1929`; para esta entidade o `JdtNum` e a chave interna/`TransId` e foi tambem armazenado no campo interno `DocEntry` do ledger FactoryOne. A releitura do documento confirmou D 1,00 em `5.01.01.01.01`, C 1,00 em `5.04.01.01.05`, filial 1, datas, identificacao tecnica, ausencia de dimensoes e diferenca de zero centavos.

Depois do logout, uma nova sessao releu Closing, PostingPlan, Claim, Execution, PDOC e Journal Entry. IDs, versoes, hashes, estados e vinculos SAP coincidiram. Resultado: Closing `POSTED` com integridade `VALID`; Claim e Execution `POSTED`; PDOC `RECONCILED`. `resumeExecution()` voltou `POSTED` sem reenviar. Chamadas financeiras adicionais: zero; total de POSTs financeiros reais nesta homologacao: **1**.

O resultado tecnico sanitizado foi mantido em `.local/ggf/phase7c-result.json` (ignorado pelo Git). Os arquivos `phase7c-preflight-failure-1.json` e `phase7c-preflight-failure-2.json` preservam as duas tentativas locais que pararam antes de qualquer escrita SAP. Nenhuma delas enviou documento financeiro.
