# GGF: identidade, persistencia e idempotencia do fechamento

## Limite desta etapa

O fechamento GGF tem `ClosingId` proprio, independente do documento SAP. A camada de dominio, o repositorio UDT/UDO e a reconciliacao de leitura foram testados offline; o claim e as linhas versionadas agora tambem foram testados na SBODEMOBR2. **Nao existe chamada de MaterialRevaluation ligada a interface ou ao adaptador SAP real nesta etapa. Nenhum novo MaterialRevaluation foi criado.** O botao geral continua desabilitado. A homologacao anterior de preco medio movel, documento 25 e diario 2278, nao foi alterada.

Em 28/09/2026 foram criados na SBODEMOBR2 os metadados `FBO_SETUP`, `FBO_LIC`, `FBO_LOG` e `FBO_GGF_CLOSE`, `FBO_GGF_CLINE`, `FBO_GGF_CLAIM`, com seus UDFs e UDOs. A releitura do plano retornou **zero acoes e zero divergencias** para core e GGF. A exposicao dos UDOs oscilou inicialmente entre sessoes (`Service Not Found`/HTTP 400 e falha de transporte); depois os endpoints responderam, sem que este projeto executasse reinicio administrativo. As versoes core e GGF foram registradas em `FBO_SETUP`. `F1CL2609281` foi criado como **DRAFT**, total zero, e relido com `CompanyDB=SBODEMOBR2` e versao 1. A segunda execucao so releu o mesmo registro (`created=false`). Isso comprova a gravacao/releitura basica do cabecalho, **nao** o claim concorrente nem o ciclo completo de POST no SAP. A [documentacao SAP de UDOs](https://help.sap.com/doc/fc2f5477516c404c8bf9ad1315a17238/10.0/en-US/Working_with_SAP_Business_One_Service_Layer.pdf) descreve o acesso por codigo de UDO; o [suporte SAP](https://community.sap.com/t5/enterprise-resource-planning-q-a/why-after-create-user-table-by-service-layer-i-need-restart-the-sl-to-use/qaq-p/12463714) registra que uma reinicializacao pode ser necessaria para expor UDO/UDF/UDT recem-criados.

## Armazenamento nativo

`GGF_CLOSING_METADATA` iniciou na versao 1 com tres UDOs Master Data. A evolucao FIFO para a versao 2 acrescenta um quarto, tambem sem exclusao comum:

| UDO | Chave | Conteudo |
| --- | --- | --- |
| `FBO_GGF_CLOSE` | `Code = ClosingId` | Empresa, periodo, filial, dimensoes JSON, status, versao, autor e datas, totais, hash, proposta, erro sanitizado, vinculo SAP, reabertura/cancelamento/notas. |
| `FBO_GGF_CLINE` | `ClosingId.versao.indice` | Conta, criterio, OP, item, deposito, base, percentual, GGF, custos anterior/ajustado, valor de reavaliacao, status da linha. Linhas de versoes anteriores permanecem como auditoria. |
| `FBO_GGF_CLAIM` | `Code = ClosingId` | Reivindicacao permanente do unico envio desse fechamento; `POST` concorrente com a mesma chave deve ser rejeitado pela unicidade do SAP. |
| `FBO_GGF_CVERS` | `ClosingId.versao` | Snapshot historico do `PostingBasis`, `PostingHash`, status e versao das linhas. Nao e documento contabil. |

Os nomes UDF no SAP usam `U_`; campos longos da especificacao sao mapeados: `SapMaterialRevaluationDocEntry -> U_SapDocEntry`, `SapMaterialRevaluationDocNum -> U_SapDocNum`, `SapJournalTransId -> U_SapTransId`. Valores monetarios e IDs sao gravados como strings decimais exatas; timestamps sao ISO UTC. `U_PostingBasis` guarda a entrada funcional para reproduzir o hash, `U_ProposedPayload` guarda o JSON exato proposto, e `U_PostingHash` guarda SHA-256 hexadecimal. Senha e sessao nunca entram nesses campos.

O repositorio rele cabecalho e versao de linhas, confere a paginacao e um `$count` independente, recalcula totais e `PostingHash`, rejeita divergencias e grava novas linhas **antes** de apontar o cabecalho para elas. Um DRAFT tecnico pode conter as linhas da versao 1, sem perder a auditoria na versao 2. A atualizacao comum de UDO por `PATCH` nao e uma transacao entre todas as linhas e o cabecalho; em falha parcial, linhas orfas ficam ignoradas pela versao do cabecalho. O `CLAIM` e a barreira de concorrencia para o envio, nao um `GET` seguido de `PATCH`. A reivindicacao nao e apagada automaticamente, inclusive apos falha. Se ela existir enquanto o cabecalho ainda estiver `READY_TO_POST`, a proxima tentativa marca `POSTING_UNCERTAIN` e **nao envia** o documento.

O header `FBO_GGF_CLOSE` **nao e historico**: `PATCH` substitui `U_PostingBasis` e `U_PostingHash` atuais. Para FIFO, `FBO_GGF_CVERS` guarda snapshots por versao e o leitor compara cada hash com o proprio `PostingBasis` e as linhas `FBO_GGF_CLINE` da `U_LineVersion` associada. Uma mudanca em `fifoLineage` cria nova versao das linhas mesmo que seus valores monetarios continuem iguais. O snapshot e append-only pela chave `Code`; nunca usar `PATCH` para corrigi-lo silenciosamente. A gravacao conjunta de header, linhas e snapshot ainda nao e transacional e exige reconciliacao fail-closed antes de qualquer contabilizacao futura.

## Status e transicoes

```text
DRAFT -> CALCULATED -> VALIDATED -> READY_TO_POST -> POSTING -> POSTED
                                 |                  |           |
                                 v                  v           v
                             CALCULATED      POSTING_UNCERTAIN FAILED
                                                   |              |
                                            reconciliar -> POSTED  POSTING_UNCERTAIN
```

`REOPENED` e `CANCELLED` existem, mas `POSTED -> REOPENED` nao estorna o documento SAP. Reabertura funcional exige um novo fechamento/versao e politica de estorno aprovada; nenhum envio automatico esta implementado. O registro inclui `ReopenedFrom`, `CancelledAt` e `Notes` para a futura trilha. `POSTING_UNCERTAIN` significa que **o POST pode ter criado o documento**. Ausencia em uma busca, por si so, nao autoriza repeticao.

Antes do envio, o coordenador exige o fechamento persistido por `ClosingId`, `READY_TO_POST`, nenhum `DocEntry`, igualdade entre hash calculado e gravado, e igualdade com a base/payload persistidos. Em seguida cria `FBO_GGF_CLAIM(Code=ClosingId)`, grava `POSTING` com hash e payload, e so entao chama o transporte injetado. Esse transporte e apenas fake nos testes; nao ha instancia SAP de escrita no produto.

Resposta SAP definitiva de rejeicao vira `FAILED`, preservando o hash e registrando so HTTP/codigo SAP. Timeout/rede ou resposta incompleta vira `POSTING_UNCERTAIN`, sem retry. Se o SAP respondeu com chaves mas a releitura falhou, as chaves sao guardadas e o estado continua incerto. `POSTED` requer releitura do documento e diario, correspondencia economica unica e persiste `DocEntry`, `DocNum`, `TransId`, `PostedAt`. `Reference1` nao participa da busca ou chave.

## PostingHash

O SHA-256 usa serializacao JSON com chaves ordenadas, contas e linhas ordenadas por identidade. Entram empresa, inicio/fim, filial, dimensoes, totais, contas/saldos/percentuais/criterios, linhas por conta/OP/item/deposito (base, GGF e custos), contas de estoque determinadas e **payload completo** da reavaliacao. Status operacional da linha, timestamps, tokens e sessao nao entram. Mudanca em qualquer componente funcional altera o hash; objeto com campo volatil ou indefinido e rejeitado. O hash nao prova que os dados SAP sao corretos: a leitura e a regra funcional ainda precisam de aprovacao.

Para FIFO, `PostingBasis.fifoLineage` acrescenta OP `DocEntry`/`DocNum`, recebimento/linha, item, deposito, quantidade originalmente produzida, identidade/quantidade/custo da camada, saldo/consumo/valor aberto e estado da trilha. `traceTimestamp` e numero da versao sao guardados para auditoria, mas **excluidos do hash funcional**; mudar qualquer identificador, quantidade, custo, valor ou `traceStatus` altera o hash. Campos da futura reavaliacao (`RevaluationDocEntry`/`DocNum`, camada resultante, quantidade/custo) ficam nulos antes do documento. O leitor recusa quantidade que nao concilie e valor aberto que nao corresponda ao custo/quantidade da camada.

## Reconciliacao apos resposta perdida

`SapRevaluationReconciliation` le todos os cabecalhos da data de lancamento, exige fim da paginacao e concilia a quantidade com `MaterialRevaluation/$count`. Busca o documento completo e `JournalEntries(TransNum)` de cada candidato. Com `DocEntry` conhecido, ele e a chave primaria; sem ele, `Comments` ou `JournalMemo` com `ClosingId` servem apenas para localizar candidatos. A decisao tambem exige data, tipo P, itens, depositos, precos, contas enviadas, valor reavaliado e equilibrio/contas do diario. Zero ou varios candidatos compativeis mantem `POSTING_UNCERTAIN`; nenhuma tentativa automatica nova e feita. Nao se usa `Reference1`: na [homologacao controlada](GGF-MATERIAL-REVALUATION-HOMOLOGATION.md), o POST 201 aceitou o campo, mas a releitura o devolveu `null`.

O vinculo oficial depois de comprovado e:

```text
FBO_GGF_CLOSE.Code (ClosingId)
  -> U_SapDocEntry (MaterialRevaluation.DocEntry)
  -> U_SapTransId (JournalEntries.JdtNum)
```

`Comments` e `JournalMemo` continuam com `FactoryOne GGF <ClosingId>` apenas para auditoria humana/localizacao. Nao sao chave unica nem criterio isolado de idempotencia.

## Testes e ativacao pendente

Os testes offline cobrem primeiro envio, duplicata, hash estavel, alteracao funcional, timeout depois do POST, reconciliacao com/sem documento, estado incerto, falha antes do POST, rejeicao SAP e falha depois do sucesso. O leitor de reconciliacao tem testes de contagem, paginacao e vinculo com diario; o repositorio testa persistencia de linhas versionadas, claim unico e transicoes. Nao houve POST real de MaterialRevaluation nesses testes.

Verificacoes finais da homologacao anterior: `npm test` passou com 444 testes em 32 arquivos; `npm run typecheck` e `npm run build` passaram. O botao de contabilizacao permanece desabilitado.

Verificacoes nativas ja executadas:

1. `node scripts/ggf-closing-metadata.mjs plan`: zero acoes/avisos para core e GGF.
2. `node scripts/ggf-closing-metadata.mjs install`: nenhuma recriacao; `FBO_SETUP` registra ambas as versoes 1.
3. `node scripts/ggf-closing-metadata.mjs smoke`: criacao e releitura de `F1CL2609281` DRAFT, totais zero; a reexecucao so rele o mesmo registro.

Pendente antes de liberar qualquer transporte real: reconciliacao contra um documento futuro, governanca de reabertura e garantias de imutabilidade contra edicao direta privilegiada no SAP. A disputa do claim e a releitura de linhas versionadas foram comprovadas abaixo. Manter o gateway de escrita e o botao geral desligados ate aprovacao funcional/contabil posterior.

O script de metadados usa a configuracao `.env` ignorada pelo Git, exige SBODEMOBR2, HTTPS/TLS verificado e uma whitelist que exclui `MaterialRevaluation`, OP, estoque e diarios. Ele nao deve ser apontado para outra empresa. A instalacao ja executada e idempotente: nao apagar as UDTs/UDOs existentes para refazer o teste.

## SAP REAL VALIDATION

Execucao em 28/09/2026, exclusivamente nos UDOs nativos da **SBODEMOBR2**, por `scripts/ggf-closing-real-validation.mjs` e seu modo `recovery`. A configuracao fica em `.env` ignorado; HTTPS exige certificado validado. Os IDs abaixo sao tecnicos e exclusivos. Contas, OPs, itens, deposito, custos e payload proposto das linhas sao **valores controlados ficticios**, gravados apenas para provar persistencia/hash. Nenhum deles foi submetido a `MaterialRevaluation`; nao representam saldo GGF ou custo SAP real. Evidencia estruturada sem credenciais/cookies em `.local/ggf/ggf-closing-real-validation.json` e `.local/ggf/ggf-closing-claim-recovery.json` (ambos ignorados pelo Git).

### Concorrencia e claim

Criado `F1HC260928A` em DRAFT. Duas sessoes autenticadas independentes tentaram `POST FBO_GGF_CLAIM` com `Code=ClosingId`, mesmo hash/versao. Os pedidos comecaram em `21:29:20.918Z` (A) e `21:29:20.919Z` (B):

| Tentativa | Sessao | HTTP | Resultado SAP sanitizado |
| --- | --- | ---: | --- |
| A | `INDEPENDENT_SESSION_A` | 201 | Claim adquirido. |
| B | `INDEPENDENT_SESSION_B` | 400 | `-2035`: `This entry already exists in the following tables (ODBC -2035)` |

Apos encerrar ambas as sessoes, uma terceira releu `FBO_GGF_CLAIM('F1HC260928A')` e `$count` independente: **1 registro**, hash e versao 1 iguais aos enviados. Nova tentativa recebeu HTTP 400/`-2035`. Enquanto o claim existia com header DRAFT incompleto, o coordenador bloqueou (`Closing DRAFT cannot be posted`); fechamento inexistente tambem foi bloqueado antes de qualquer chamada financeira. A transicao do header para `CANCELLED` foi persistida; o claim continuou unico, a tentativa de POST foi bloqueada pelo estado final e outro `POST` de claim recebeu HTTP 400. Contador do gateway financeiro: **0**.

Teste adicional `F1HC260928B`: header com linhas foi avancado, apenas nos UDOs, de DRAFT ate `READY_TO_POST` (versao 4); o claim foi criado e a sessao encerrada **antes** de qualquer transporte financeiro. Em outra sessao, `GgfPostingCoordinator.post()` encontrou o claim preexistente, gravou `POSTING_UNCERTAIN` (versao 5, `CLAIM_EXISTS_BEFORE_POSTING_STATE`) e nao chamou o gateway. Repeticao a partir do estado incerto foi bloqueada. Novo login confirmou header incerto, duas linhas, hash e claim versao 4. O teste mostra recuperacao *fail closed*, nao prova que um documento SAP tenha sido criado; por isso o claim nao pode ser apagado/reutilizado automaticamente.

### Linhas e versoes

`F1HL260928A` foi criado com header DRAFT e **duas linhas tecnicas na versao 1**, relido apos encerrar a sessao. Um dado funcional da segunda linha mudou (`U_Allocated` de `2.00` para `2.50`), criando header CALCULATED e duas linhas separadas na **versao 2**. Novo login releu diretamente o header e ambas as versoes de `FBO_GGF_CLINE`, comparando cada campo de linha (`U_Account`, `U_Criterion`, `U_OrderId`, `U_Item`, `U_Warehouse`, `U_Basis`, `U_Percent`, `U_Allocated`, `U_CostBefore`, `U_CostAfter`, `U_Revaluation`, `U_Status`), `U_ClosingId`, `U_Version`, campos do header, `U_PostingBasis` e `U_ProposedPayload`.

| Versao | Status | Linhas `$count`/lidas | `TotalGgf` = `TotalAllocated` = `TotalRevalued` | `PostingHash` |
| ---: | --- | ---: | ---: | --- |
| 1 | DRAFT | 2/2 | `3.00` | `efbef556cefab73d0ca549e33fbc36e595a60f6b5be66337221d7e80906b3e9e` |
| 2 | CALCULATED | 2/2 | `3.50` | `567dfc33d1d2f5f2ffde63f1bb5825b44798208b331118a5ef8dfb176f33cac0` |

As linhas da versao 1 permaneceram com `2.00`, e as da versao 2 com `2.50`; o hash mudou. O leitor confere soma das linhas aplicaveis em centavos contra `TotalGgf`/`TotalAllocated`, soma de `U_Revaluation` contra `TotalRevalued`, contagem independente e hash recalculado da base funcional persistida. Uma tentativa de substituir o header com total `4.00` foi rejeitada **antes do PATCH**. Testes offline tambem injetam header/hash adulterados na releitura e verificam erro explicito.

### Imutabilidade e limites

Nao foi gravado um falso `POSTED` no SAP, pois isso criaria um vinculo contabil inexistente. Um teste offline simula `POSTED` com vinculo tecnico e demonstra que o repositorio rejeita alteracao funcional, aceitando apenas transicao de reabertura que preserva conteudo e vinculo. No SAP real, uma tentativa direta `CALCULATED -> POSTED` pelo repositorio foi bloqueada antes do PATCH, e releitura confirmou o header inalterado. **Isto nao prova imutabilidade imposta pelo SAP contra um usuario privilegiado que edite o UDO diretamente**: a garantia atual e da camada FactoryOne. Bloqueio administrativo/`TransactionNotification`, permissoes e politica de reabertura ainda exigem decisao e teste antes de contabilizacao geral.

Outros limites: o claim unico prova exclusao entre duas criacoes concorrentes neste teste, nao atomicidade de header+linhas; uma falha parcial pode deixar linhas orfas sem apontamento pelo header. Os IDs tecnicos e claims permanecem no SAP para auditoria. `F1HC260928B` permanece intencionalmente em `POSTING_UNCERTAIN`, sem documento financeiro associado. A validacao nao homologa FIFO, preco padrao, lote, regras contabeis ou gateway de POST.

## Integridade pos-contabilizacao

Ao carregar um header `POSTED` (ou `REOPENED` ainda vinculado ao documento), `SapGgfClosingRepository.get()` rele o header, a versao ativa de todas as linhas com `$count` independente e o claim por `ClosingId`. Reconstroi a entrada funcional com **valores atuais relidos do header e das linhas**, mais contas/parametros do `U_PostingBasis`, e recalcula o SHA-256. Compara o resultado ao `U_PostingHash` e ao hash original do `FBO_GGF_CLAIM`. Tambem exige linhas com `Code`, `U_ClosingId` e `U_Version` coerentes, totais em centavos, base/payload persistidos, vinculo SAP e versao de fechamento posterior ao claim. Um `REOPENED` vinculado permanece somente leitura; novo calculo exige outro `ClosingId`.

O relatorio de leitura usa `VALID`, `INTEGRITY_VIOLATION` ou `NOT_APPLICABLE` (fechamento ainda nao POSTED). Uma violacao lanca `ClosingIntegrityViolation` antes de entregar o fechamento ao coordenador: nao ha reabertura, nova contabilizacao, preparacao de payload ou alteracao funcional. Falha de rede/Service Layer continua erro de leitura e tambem bloqueia a operacao, mas nao e rotulada automaticamente como adulteracao. Nao ha correcao automatica. Alteracao de status que deixa `PostedAt`/vinculo SAP em um estado nao contabilizado tambem e bloqueada.

O evento inclui `ClosingId`, versao, hash original do claim, hash do header, hash recalculado (ou `null` se nao houver entrada valida), instante UTC, campos divergentes e usuario/rotulo de requisicao quando fornecidos. O rotulo aceito e apenas um identificador da aplicacao (`app-*` ou `local-preview`), **nunca** `B1SESSION`, cookie ou token. O repositorio tenta registrar a violacao em `FBO_LOG`; se o log falhar, a operacao permanece bloqueada e `auditRecorded=false`. Na previa local `sap-read`, o endpoint `/__ggf/closing-integrity?closingId=...` faz somente GET no SAP e grava incidentes em `.local/ggf/closing-integrity-incidents.jsonl` (ignorado pelo Git), sem escrever no SAP. A tela mostra "Integridade verificada" para VALID e o alerta critico "Fechamento alterado apos contabilizacao. Operacao bloqueada." para violacao. A simulacao local mostra integridade nao aplicavel. O uso do cliente nativo/SSO dentro do Web Client e a permissao de gravar `FBO_LOG` **ainda precisam de teste no host**.

Testes offline adulteram header, linha, contagem por remocao/adicao, hash ausente ou reescrito, identidade/versao da linha, versao do header e status com vinculo SAP. Tambem exercitam bloqueio de POST, preparo de payload e reabertura, inclusive quando a auditoria nao pode ser gravada. Nenhum UDO real da homologacao foi alterado para esses testes; nao houve MaterialRevaluation.

Na previa local `sap-read`, `http://localhost:8084` respondeu 404 para um ClosingId inexistente e 200/`NOT_APPLICABLE` para o fechamento tecnico CALCULATED `F1HL260928A`, ambos somente GET no SAP. Nenhum POSTED real foi adulterado ou criado. A verificacao automatizada e visual atual esta descrita em **Homologacao visual** abaixo.

### Permissoes SAP

A [documentacao oficial de autorizacoes para UDOs](https://help.sap.com/docs/SAP_BUSINESS_ONE/2dc2e07e933b4dd5b93ab6405dcfb6af/fe208b82873745cc8168b055665124ca.html) explica que `ApplyAuthorization` expoe o objeto nas Autorizacoes Gerais; a [API do Service Layer](https://help.sap.com/doc/2ae9e7a283a44cb082c422a8ab62d98f/10.0/en-US/10.0_FP2208_VS_FP2202.html) disponibiliza esse campo em `UserObjectsMD`. Na SBODEMOBR2, o baseline de 28/09/2026 era `tNO` nos UDOs `FBO_GGF_CLOSE`, `FBO_GGF_CLINE` e `FBO_GGF_CLAIM`. Foi aplicado PATCH **somente** de `{ "ApplyAuthorization": "tYES" }` em cada um: HTTP 204 nas tres respostas. GET imediato e releitura em nova sessao comprovaram `tYES`; todas as demais propriedades permaneceram identicas ao baseline. O arquivo completo antes/depois esta em `.local/ggf/ggf-udo-authorization.json` (ignorado pelo Git). Novas instalacoes tambem criam esses tres UDOs com `tYES`. O instalador existente nao migra automaticamente UDOs ja instalados; a alteracao desta base foi explicita e auditada.

A matriz detalhada esta em [GGF-AUTHORIZATION-MATRIX.md](GGF-AUTHORIZATION-MATRIX.md): `FACTORYONE_GGF_OPERATOR` consulta e simula; `FACTORYONE_GGF_POSTING` podera preparar o fechamento, mas nao recebe administracao dos UDOs nem POST financeiro nesta etapa; `FACTORYONE_ADMIN` instala e administra a estrutura. `ApplyAuthorization=tYES` **nao atribui permissoes a usuarios**. So havia credencial tecnica de implantacao disponivel: seus GETs dos tres UDOs retornaram HTTP 200, mas nao foi possivel comprovar os bloqueios do operador ou o perfil posting com sessoes distintas. A atribuicao e o teste dessas permissoes permanecem pendentes de implantacao, sem afrouxar autorizacoes globais. O controle de claim, versao, `PostingHash` e `INTEGRITY_VIOLATION` continua obrigatorio. Um superusuario SAP pode alterar UDOs e ate evidencias coerentemente; sem ancora externa imutavel, nao existe garantia absoluta contra essa acao privilegiada. A [documentacao SAP sobre superusuarios](https://help.sap.com/docs/SAP_BUSINESS_ONE/3c3b1c0fbaa44074936934be48b06b68/dc32958dcacf485f94cf6681ddef2eaf.html) aponta essa limitacao.

### Homologacao visual

No WSL2 Ubuntu 24.04.3, o Chromium do Playwright nao encontrava `libnspr4.so`, `libnss3.so` e `libasound.so.2`. Sem alterar codigo de producao nem exigir `sudo`, pacotes oficiais Ubuntu `libnspr4`, `libnss3`, `libasound2t64` e `libasound2-data` foram extraidos em `/home/mpedrozo/.local/share/factoryone/playwright-deps/root`. Para reproduzir neste ambiente, com os pacotes oficiais disponiveis via `apt`:

```sh
mkdir -p "$HOME/.local/share/factoryone/playwright-deps"
cd "$HOME/.local/share/factoryone/playwright-deps"
apt download libnspr4 libnss3 libasound2t64 libasound2-data
for package in ./*.deb; do dpkg-deb -x "$package" root; done
PATH="/tmp/factoryone-tools/node_modules/node/bin:$PATH" \
  LD_LIBRARY_PATH="$PWD/root/usr/lib/x86_64-linux-gnu" npm run test:browser
```

O teste `test/browser/ggf-integrity.spec.mjs` percorre desktop (1440 px) e mobile (390 px) com respostas **controladas** para `NOT_APPLICABLE`, `POSTED/VALID`, `POSTED/INTEGRITY_VIOLATION` e `REOPENED` vinculado. Confere consulta por `ClosingId`, campos somente leitura, estado, documento SAP, alerta critico, bloqueio de avancar, hashes ocultos e ausencia de rolagem horizontal. Capturas locais: `.local/ggf/visual/ggf-integrity-{not-applicable,posted-valid,posted-violation,reopened-valid}-{1440,390}.png`. Elas demonstram a interface, **nao** sao evidencia de POSTED ou violacao real no SAP. Tipografia, SSO e encaixe final dentro do Web Client instalado ainda dependem de homologacao no host; a suite existente tambem verifica o tema escuro na previa.

Resultado final: `npm test` com Node 24 passou **457/457** em 32 arquivos; `npm run typecheck` passou; `npm run build` com o `mbt` Linux gerou `mta_archives/ext-factoreone_0.1.0.mtar` (aviso de *clock skew* do WSL); Playwright completo passou **27/27** em desktop/mobile, incluindo os dois cenarios novos de integridade. A primeira tentativa com o Node 18 do sistema falhou por ausencia de `crypto` global; a execucao valida usou `/tmp/factoryone-tools/node_modules/node/bin`. A previa `sap-read` atualizada retornou HTTP 200 por GET para `F1HL260928A`, ainda `NOT_APPLICABLE`. Nenhum `MaterialRevaluation` foi criado.

### Fluxo de incidente

1. Manter fechamento e contabilizacao bloqueados; nao sobrescrever header, linhas, claim ou log.
2. Preservar o relatorio de integridade, as versoes historicas e os documentos SAP associados; correlacionar `DocEntry` e `TransId` por leitura independente.
3. Conferir quem alterou UDOs e permissoes, e decidir com contabilidade/administracao sobre restauracao ou novo fechamento. Nenhum reparo automatico ou novo POST com o mesmo `ClosingId`.

## FIFO POSTING BASIS: validacao tecnica de 29/09/2026

`F1HL260929F` e um fechamento **somente tecnico**, na SBODEMOBR2, com uma linha `TECH-NOT-GGF`, percentual 0 e `TotalGgf=TotalAllocated=TotalRevalued=0.00`. Seu `payload` contem `technicalOnly=true`, `noPosting=true` e `MaterialRevaluationLines=[]`; nao e documento executavel. A origem real da trilha e OP 83/214, recebimento 77/122 linha 0, camada FIFO 2792/0 de 10 UN a R$ 12,00 e saida 40/90 de 6 UN, restando 4 UN/R$ 48,00. [Detalhes da prova](GGF-MATERIAL-REVALUATION-FIFO.md).

O header e as linhas foram gravados e relidos em novas sessoes:

| Versao | Header | Linha | `traceStatus` | Hash |
| ---: | --- | --- | --- | --- |
| 1 | `DRAFT`, `Version=1`, `LineVersion=1` | `F1HL260929F.00001.0001` | `FIFO_PARTIALLY_CONSUMED` | `0cba99cb93a810baea8079c473949b9964bb57c71500ff979d686bd29f350437` |
| 2 | `CALCULATED`, `Version=2`, `LineVersion=2` | `F1HL260929F.00002.0001` | `FIFO_TRACE_AMBIGUOUS` | `c17d3681d35aa49b84dd71fecd19245ccdafd29f01f5acfb8d5739c1e8f6ced5` |

A **unica mudanca controlada no conteudo FIFO** da versao 2 foi `traceStatus`; ela e deliberadamente ambigua e **nao deve ser usada para contabilizacao**. A mudanca de status/numero da versao do fechamento e parte do ciclo de vida. As linhas das duas versoes continuam separadas no SAP e os hashes diferem. Nenhum claim foi criado, nenhum `DocEntry` financeiro foi preenchido. O header atual aponta para a versao 2, portanto **o `PostingBasis` completo da versao 1 nao permanece no header**: nao confundir suas linhas antigas com um snapshot historico completo.

Para corrigir isso, o instalador criou em 29/09/2026 `FBO_GGF_CVERS` e seus campos (`PostingBasis` memo, hash, `ClosingId`, versao, `LineVersion`, status, instante e marcador tecnico), elevando a versao GGF de metadados para **2**. O plano antes da instalacao tinha 0 acoes core, 10 acoes GGF e nenhum aviso; a instalacao concluiu as 10 e gravou a versao 2. `UserObjectsMD('FBO_GGF_CVERS')` foi relido com `ApplyAuthorization=tYES`, `CanDelete=tNO`. A exposicao do novo endpoint oscilou entre HTTP 200 e HTTP 400 `Service Not Found` em sessoes independentes, mesmo apos passar a responder. Isso sugere instancias da Service Layer com metadados desencontrados; **a causa operacional nao foi comprovada**. O [manual SAP da Service Layer](https://help.sap.com/doc/fc2f5477516c404c8bf9ad1315a17238/10.0/en-US/Working_with_SAP_Business_One_Service_Layer.pdf) informa que UDO/UDF/UDT novos podem exigir reinicializacao do servico para ficarem acessiveis. O FactoryOne nao reiniciou a Service Layer.

Quando a entidade ficou acessivel, foram criados snapshots append-only `F1HL260929F.00001` e `F1HL260929F.00002`. A releitura em nova sessao recalculou cada `PostingHash`, comparou o `PostingBasis` completo, a contagem independente e todos os campos da respectiva linha `FBO_GGF_CLINE`. A versao 1 conserva `FIFO_PARTIALLY_CONSUMED` e hash `0cba99cb...350437`; a versao 2 conserva `FIFO_TRACE_AMBIGUOUS` e hash `c17d3681...f6ced5`. Os hashes sao distintos, `TotalGgf=0.00`, nao ha claim nem `SapMaterialRevaluationDocEntry`. A prova local, sem credenciais, esta em `.local/ggf/fifo-closing-F1HL260929F-proof.json`. Na primeira gravacao de snapshot a resposta se perdeu; **nao houve repeticao do POST**: o `Code`, o hash e o conteudo completo foram reconciliados por GET antes de marcar a tentativa como persistida. A versao 2 permanece identificada como homologacao tecnica, nao como calculo funcional apto.

O repositorio `SapGgfClosingVersionRepository` cria snapshots append-only, rele hash e base de cada versao, concilia `$count` e campos das linhas associadas e detecta adulteracao ou ausencia. O roteiro `scripts/ggf-fifo-closing-validation.mjs verify-archive` reproduz a verificacao somente de leitura; uma sessao pode receber HTTP 400 enquanto a exposicao do UDO continuar intermitente. Essa instabilidade deve ser resolvida na operacao da Service Layer antes de depender do novo UDO em producao. Esta evolucao de metadados nao mudou o motor GGF nem habilitou MaterialRevaluation ou Journal Entry.

Verificacoes locais desta etapa: `npm test` **479/479** em 36 arquivos, `npm run typecheck` aprovado, `npm run build` aprovado e `npx playwright test` **29/29**. Capturas da previa FIFO: `/tmp/factoryone-browser-results/revaluation-technical-FIFO-c84a1-from-functional-totals-1440/fifo-trace-1440.png` e `/tmp/factoryone-browser-results/revaluation-technical-FIFO-bff23--from-functional-totals-390/fifo-trace-390.png`. O build gerou `mta_archives/ext-factoreone_0.1.0.mtar`, com aviso de relogio do WSL (*clock skew*).

## Dependencia da exposicao do UDO de versoes

Em 29/09/2026 foi investigado o HTTP 400 `Service Not Found` intermitente de `FBO_GGF_CVERS`. Uma entre 70 sessoes de diagnostico recebeu `$metadata` sem o UDO, embora `UserObjectsMD` e os UDOs anteriores respondessem. Outras 69 leram a versao existente; uma verificacao separada de 16 sessoes confirmou os quatro UDOs nas quatro rotas observadas. A causa imediata e metadata desatualizada na Service Layer; o processo/cache responsavel requer logs administrativos. O Controller nao estava disponivel nesse endereco, portanto nao houve reinicio. [Diagnostico e procedimento](SAP-UDO-SERVICE-LAYER-STABILITY.md).

`SAP_METADATA_UNAVAILABLE` agora bloqueia preparo e envio antes do claim, sem tratar o UDO como ausente; a interface de integridade mostra erro operacional e aceita nova consulta. O instalador exige releitura do cadastro e endpoint em sessoes novas antes de registrar uma futura versao. Esses controles nao homologam disponibilidade de producao nem liberam contabilizacao. O motor matematico de GGF e a homologacao FIFO persistente permaneceram inalterados.

Verificacoes apos esse ajuste: 485 testes unitarios, typecheck, build e 30 testes de navegador aprovados. Nenhuma escrita SAP foi realizada nesta investigacao; o Controller nao estava acessivel no endereco testado, e a causa operacional do cache intermitente ainda exige analise dos logs dos membros da Service Layer.
