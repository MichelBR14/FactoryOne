# GGF V2 — Persistencia SAP do PostingPlan

## Homologacao tecnica - 01/10/2026

A estabilidade PPLAN foi comprovada depois que o certificado da SL expirou. Com autorizacao explicita do usuario, a homologacao usou HTTPS com excecao local e escopada de validacao de certificado (`FBO_SL_ALLOW_INVALID_CERTIFICATE=1`), mantendo a criptografia. Nao foi usado `NODE_TLS_REJECT_UNAUTHORIZED=0`, HTTP nem bypass global. Esse modo e exclusivo de scripts locais de teste; impede POST financeiro, alteracao de OP, estoque e lancamentos.

`verify-exposure` passou em 16/16 sessoes GGF novas nos nos 1–4 e 8 sessoes core. Duas baterias temporais de 50 sessoes passaram 50/50 cada, separadas por aproximadamente 6 minutos, total 100/100. Cada uma viu `$metadata` com PPLAN, endpoints HTTP 200, fechamento/versoes de controle acessiveis e logout; zero `Service Not Found`. Evidencias sanitizadas e ignoradas pelo Git: `.local/ggf/udo-sl-stability-2026-10-01T11-59-32.786Z.json` e `.local/ggf/udo-sl-stability-2026-10-01T12-06-10.680Z.json`. A instalacao idempotente seguinte criou zero objetos, passou nova verificacao de exposicao e registrou a versao GGF 3 em `FBO_SETUP`.

O UDO `FBO_GGF_PPLAN` esta instalado sem filhos, `ApplyAuthorization=tYES`, `CanDelete=tNO`. Seu `Code` tem 19 caracteres: `P` + prefixo SHA-256 de 14 caracteres do ClosingId + sequencia de quatro digitos. O snapshot integral fica no campo Memo `U_PlanSnapshot`; header indexavel guarda ClosingId, versoes, hash, status, totais e auditoria. A leitura real ao vivo do periodo 01-30/09/2026 reproduziu MOD `-300000` centavos, GGF `-616600`, estoque `0`, CPV `0`, bloqueado `-916600`, diferenca matematica `0`, tres linhas e todos os payloads `null`.

Um unico POST tecnico criou `TECH-SBODEMOBR2-202609`, versao 1, status `BLOCKED`. O repositorio confirmou readback e hash em uma sessao independente. Mais tres releituras sequenciais em sessoes novas retornaram a mesma versao, tres linhas, totais e hash SHA-256 `2ce63b4c70b37c00d20bc08394ea43b0b4925a36df346b47e6f83f61a7cd17b8`. Uma prova adicional com tres logins simultaneos teve um HTTP 500 no login; as releituras sequenciais passaram e a bateria de 100 sessoes temporais tambem. Registrar o 500 como limitacao de carga/concorrencia, nao como divergencia do registro.

Nenhum claim foi criado. Nenhum MaterialRevaluation, Journal Entry, alteracao de OP, recurso ou estoque foi enviado. O plano tecnico fica inelegivel para `READY_TO_POST` e nao libera contabilizacao funcional. Evidencia completa, com dados SAP e sem credenciais/sessoes, esta em `.local/ggf/v2-posting-plan-technical-snapshot.json` e nao entra no Git.

O adaptador SAP e append-only, verifica o hash apos leitura, evita POST duplicado de versao igual, e trata resposta ambigua sem repost automatico. O preview local le planos do SAP e nao migra snapshots V1 de `localStorage`.

Verificacao local: `npm test` 534/534; `npm run typecheck` aprovado; `npm run build` aprovado; scripts ESM passaram em `node --check`; `git diff --check` limpo. Playwright focado nao iniciou Chromium porque Ubuntu 24.04/WSL nao possui `libnspr4.so`; `npx playwright install-deps chromium` falhou sem sudo. Nenhuma captura foi produzida nesta rodada.

## Resultado da Fase 6

**PostingPlan tecnico persistido e verificado; contabilizacao financeira continua bloqueada.** A migracao do UDO v3 foi completada, a fonte SAP e lida por sessao nova, e os snapshots V1 do `localStorage` nao foram migrados.

## Auditoria do modelo existente

| Objeto | Contrato observado | Adequacao ao PostingPlan |
| --- | --- | --- |
| `FBO_GGF_CLOSE` | Header atual por `ClosingId`; guarda estado corrente, versao corrente, totais, hash/base e vinculo SAP. | Inadequado como historico append-only de varias versoes de PostingPlan. Atualizar o header substitui a versao corrente e pode misturar ciclo de fechamento com ciclo de plano. |
| `FBO_GGF_CLINE` | Linhas de auditoria do fechamento associadas por `ClosingId` e `Version`, com conta, criterio, OP/item, deposito, base, percentual, alocado, custos e reavaliacao. | Incompleto: nao tem origem detalhada, quantidade/unidade, conta de debito/credito, dimensoes, destino estoque/consumido, metodo de avaliacao, documento previsto, dependencias e bloqueios completos. Expandir/reinterpretar essas linhas colocaria em risco snapshots V1. |
| `FBO_GGF_CVERS` | Um snapshot append-only por `ClosingId.Version`; `U_PostingBasis` memo, hash, status, versao de linhas e instante. A verificacao recalcula hash e compara as linhas de `CLINE`. | Proximo conceitualmente, mas a identidade `Version` pertence ao fechamento e nao distingue multiplos recalculos de PostingPlan dentro da mesma versao. Reusar `PostingBasis` para outro schema quebraria o contrato do leitor existente. Nao sobrescrever nem reinterpretar registros. |
| `FBO_GGF_CLAIM` | Claim unico por fechamento, utilizado para impedir duplicidade do POST financeiro. | **Nao reutilizar** para gravacao de plano. Claim financeiro permanece intocado e nenhum claim pode ser criado nesta fase. |

Os objetos existentes, em seus contratos atuais, nao suportam a identidade independente, versionamento append-only e snapshot completo de documentos/linhas do PostingPlan sem mudar semantica V1. Por isso `FBO_GGF_PPLAN` foi criado isoladamente; os UDOs V1 nao foram reinterpretados.

## Contrato instalado

O UDO master-data `FBO_GGF_PPLAN`, sem filhos e sem dependencia de `CLAIM`, foi instalado e relido pela Service Layer. Cada registro e uma versao imutavel do PostingPlan. `Code` e `P` + os primeiros 14 caracteres hexadecimais do SHA-256 de `ClosingId` + versao de quatro digitos; o Code de homologacao tem 19 caracteres. `U_ClosingId`/`U_Version` e `U_PostingPlanVersion` guardam a identidade legivel completa. Reuso de Code em outro ClosingId e validado contra esses campos e gera erro de integridade.

Campos do header: `ClosingId`, `Version`, `PostingPlanVersion`, `PostingHash`, `CreatedAt`, `CreatedBy`, `Status`, `TotalMod`, `TotalGgf`, `TotalStock`, `TotalCpv`, `TotalBlocked`, `AcctDifference` e Memo `PlanSnapshot`. O Memo armazena o snapshot canonico completo, incluindo documentos previstos, linhas, dimensoes, dependencias, referencias de origem e bloqueios; uma unica criacao evita gravacoes parciais entre multiplas UDOs. A versao de esquema GGF 3 foi registrada em `FBO_SETUP` depois da verificacao de exposicao.

O snapshot de homologacao fez round-trip JSON, Unicode, campos e hash sem truncamento. Isso comprova o tamanho deste snapshot, nao o limite maximo do Memo nem concorrencia de duas criacoes. O repositório nunca usa PATCH/DELETE; versoes funcionais novas sao append-only, snapshot inalterado retorna a versao atual.

## Persistencia, integridade e concorrencia

1. Antes de criar, confirmar endpoint e metadata. Ausencia, HTTP `Service Not Found`, metadata divergente ou falha de transporte resulta em `SAP_METADATA_UNAVAILABLE`; nao usar cache local como autoridade.
2. Ler versoes existentes por ClosingId e escolher a proxima sequencia. Hash SHA-256 cobre conteudo funcional e payloads nulos, exclui timestamps, criador e horario de captura.
3. Um POST unico cria o snapshot tecnico. HTTP 409/duplicidade e conflito; falha de transporte e `POSTING_PLAN_WRITE_UNCERTAIN`; ambos exigem releitura, nunca repost automatico.
4. Leitura independente em nova sessao refaz contagem/paginacao, confere header contra Memo e recalcula PostingHash. O primeiro POST real foi relido em quatro sessoes sequenciais, sempre a mesma versao/hash/totais/linhas.
5. A disputa simultanea para criar a mesma versao do PostingPlan ainda nao foi homologada no SAP. Uma bateria de tres leituras simultaneas teve um login HTTP 500; as releituras sequenciais passaram. Nao afirmar concorrencia real do PPLAN ate um teste dedicado.
6. `localStorage` V1 nao fundamenta status, versao, integridade ou elegibilidade; nenhum registro local foi importado.

MaterialRevaluation, Journal Entry, claim financeiro, reavaliacao e atualizacao de custo permanecem desabilitados. O unico POST de dados foi `FBO_GGF_PPLAN` em status `BLOCKED`.

## Estado do cenario tecnico

O snapshot SAP atual refere-se a `TECH-SBODEMOBR2-202609`, versao 1, hash `2ce63b4c70b37c00d20bc08394ea43b0b4925a36df346b47e6f83f61a7cd17b8`. Status `BLOCKED`; MOD `-R$ 3.000,00`; GGF `-R$ 6.166,00`; estoque `R$ 0,00`; CPV `R$ 0,00`; bloqueado `-R$ 9.166,00`; diferenca `R$ 0,00`. Tres linhas correspondem as OPs 76, 77 e 79. Sao valores de homologacao tecnica, nao fechamento funcional. Nenhum payload financeiro foi gerado.

## Pendencias para destravar

- Renovar o certificado do servidor antes de deixar de usar a excecao local; ela nao autentica a identidade do servidor, embora mantenha HTTPS.
- Homologar concorrencia real de criacao de Code duplicado do PPLAN.
- Completar Playwright depois de instalar dependencias Chromium no WSL.
- A regra contabil funcional, saldo absorvivel final, contas, custo padrao ja absorvido e elegibilidade estoque/CPV ainda precisam de decisao/aprovacao. O plano tecnico nao representa fechamento contábil aprovado.
- Nenhuma contabilizacao pode usar somente este snapshot tecnico `BLOCKED`.
