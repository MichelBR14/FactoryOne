# GGF V2 — Persistencia SAP do PostingPlan

## Resultado da Fase 6

**Migracao ainda bloqueada; nenhuma escrita SAP foi executada.** A fonte oficial corporativa ainda nao esta implementada. Os snapshots da Fase 5 em `localStorage` sao provas tecnicas locais e nao podem autorizar nem fundamentar contabilizacao. Nao foram migrados automaticamente.

Em 30/09/2026, uma verificacao somente de leitura abriu tres logins independentes na `SBODEMOBR2`. Em todas as sessoes, `$metadata` continha `FBO_GGF_CVERS`; os endpoints dos snapshots tecnicos `.00001` e `.00002` e o fechamento de controle responderam HTTP 200. As tres sessoes, contudo, foram roteadas para `node2` (mesmo fingerprint de rota). Isto confirma disponibilidade naquela rota e horario, mas **nao estabilidade de todos os membros**. A anomalia anterior permanece: uma de 70 sessoes recebeu metadata sem `FBO_GGF_CVERS`, seguida por falha de socket. Nao ha evidencia de reinicio controlado seguido pela bateria multi-rota exigida.

Evidencia sanitizada desta amostra, ignorada pelo Git: `.local/ggf/udo-sl-stability-2026-09-30T22-21-26.703Z.json`. O script usou logins novos, GETs e logout; nao fez POST, PATCH nem alteracao de metadata. Resultado: 3/3 leituras aprovadas, 1 no ainda observado, zero escrita. Por causa da evidencia historica, nao classificar a infraestrutura como homologada nem persistir plano nela nesta fase.

## Auditoria do modelo existente

| Objeto | Contrato observado | Adequacao ao PostingPlan |
| --- | --- | --- |
| `FBO_GGF_CLOSE` | Header atual por `ClosingId`; guarda estado corrente, versao corrente, totais, hash/base e vinculo SAP. | Inadequado como historico append-only de varias versoes de PostingPlan. Atualizar o header substitui a versao corrente e pode misturar ciclo de fechamento com ciclo de plano. |
| `FBO_GGF_CLINE` | Linhas de auditoria do fechamento associadas por `ClosingId` e `Version`, com conta, criterio, OP/item, deposito, base, percentual, alocado, custos e reavaliacao. | Incompleto: nao tem origem detalhada, quantidade/unidade, conta de debito/credito, dimensoes, destino estoque/consumido, metodo de avaliacao, documento previsto, dependencias e bloqueios completos. Expandir/reinterpretar essas linhas colocaria em risco snapshots V1. |
| `FBO_GGF_CVERS` | Um snapshot append-only por `ClosingId.Version`; `U_PostingBasis` memo, hash, status, versao de linhas e instante. A verificacao recalcula hash e compara as linhas de `CLINE`. | Proximo conceitualmente, mas a identidade `Version` pertence ao fechamento e nao distingue multiplos recalculos de PostingPlan dentro da mesma versao. Reusar `PostingBasis` para outro schema quebraria o contrato do leitor existente. Nao sobrescrever nem reinterpretar registros. |
| `FBO_GGF_CLAIM` | Claim unico por fechamento, utilizado para impedir duplicidade do POST financeiro. | **Nao reutilizar** para gravacao de plano. Claim financeiro permanece intocado e nenhum claim pode ser criado nesta fase. |

Os objetos existentes, em seus contratos atuais, nao suportam a identidade independente, versionamento append-only e snapshot completo de documentos/linhas do PostingPlan sem mudar semantica V1. Nao foi criado UDO novo nem alterado UDO existente.

## Estrutura minima proposta

Propor um UDO master-data isolado `FBO_GGF_PPLAN`, sem filhos e sem dependencia de `CLAIM`. Cada registro e uma versao imutavel do PostingPlan. `Code` e a chave unica derivada de `ClosingId + ClosingVersion + PostingPlanVersion`; a composicao e tamanho final precisam ser validados com as restricoes reais do SAP antes do instalador ser executado.

Campos indexaveis do header: `ClosingId`, `ClosingVersion`, `PostingPlanVersion`, `PostingHash`, `CreatedAt`, `CreatedBy`, `Status`, `TotalMod`, `TotalGgf`, `TotalStock`, `TotalCpv`, `TotalBlocked` e `AccountingDifference`. Um campo Memo `PlanSnapshot` guardaria o documento canonico completo, incluindo documentos previstos, linhas, dimensoes, dependencias, referencias de origem, bloqueios, currency e os respectivos campos financeiros. Isso evita gravacoes parciais entre varias UDOs e permite reler/hashificar um unico snapshot.

Essa e a menor estrutura candidata, nao uma metadata aprovada. Antes da implantacao, deve-se confirmar por documentacao/contrato SAP e teste controlado: limite real de tamanho do Memo via Service Layer; round-trip Unicode/JSON; tamanho maximo observado do plano; limite/tamanho de `Code`; propriedades e autorizacoes UDO; e comportamento de concorrencia para duas criacoes com mesmo Code. Se o snapshot exceder o limite comprovado, parar e propor estrutura normalizada de documentos/linhas, com chaves append-only e protocolo de commit/reconciliacao, em vez de truncar ou dividir silenciosamente.

## Persistencia e concorrencia futuras

1. Antes da operacao, confirmar metadata atual e disponibilidade do endpoint PPLAN em logins novos. Ausencia, HTTP `Service Not Found`, metadata divergente ou falha de transporte resulta em `SAP_METADATA_UNAVAILABLE` e bloqueio; nao usar cache local como autoridade.
2. Ler versoes existentes por `ClosingId` e `ClosingVersion`; escolher `PostingPlanVersion = max + 1`.
3. Construir hash deterministico do snapshot canonico funcional (incluindo identidade/versao, totais, documentos e linhas), sem timestamps ou sessao.
4. Criar um unico registro com POST somente depois da homologacao de metadata e do contrato. O Codigo SAP unico deve transformar disputa da mesma versao em conflito explicito; reler apos conflito, sem PATCH/substituicao automatica. Esse comportamento ainda precisa de teste SAP real antes de ser considerado comprovado.
5. Encerrar a sessao, abrir uma sessao independente, reler pelo Code/ClosingId e recalcular o hash dos campos persistidos. Divergencia mantem integridade invalida e nenhuma versao e promovida a oficial.
6. Sessoes B/C devem reconstruir versao, totais, linhas, bloqueios e hash diretamente do SAP. `localStorage` pode manter apenas cache descartavel identificado como `LEGACY_LOCAL`; nao participa da decisao de status, versao, integridade ou elegibilidade.

Nao enviar POST de MaterialRevaluation, Journal Entry nem claim financeiro. POST do futuro UDO tecnico de plano tambem permanece desabilitado ate a dependencia de metadata, schema, autorizacoes e concorrencia ser homologada. O teste desta fase foi somente GET.

## Estado do cenario tecnico

O snapshot local previamente verificado refere-se a `TECH-SBODEMOBR2-202609`, versao local 1, hash `bef780c754cb40c8305db630f844f57f622b1966c743c914249fadbaff93a5be`. Ele permanece `BLOCKED`: estoque R$ 0,00; CPV R$ 0,00; bloqueado R$ 9.166,00; diferenca R$ 0,00. Sao valores de homologacao tecnica, nao fechamento funcional. Esse snapshot **nao foi persistido no SAP** nesta Fase 6 e nao e migrado automaticamente do navegador.

## Pendencias para destravar

- Administracao SAP deve concluir janela controlada e registrar restart suportado de todos os membros relevantes, sem reiniciar banco sem necessidade.
- Repetir validacao multi-sessao/temporal e provar metadata/endpoints em todos os nos que atendem trafego; a amostra de 3 logins em `node2` nao atende esse criterio.
- Aprovar o schema PPLAN e provar tamanho do Memo, chaves, autorizacoes e round-trip antes de atualizar metadata.
- Implementar adaptador SAP, concorrencia por chave unica, auditoria/releitura nova sessao, estados de indisponibilidade e testes multiusuario controlados.
- Homologar a UI reconstruindo somente a partir do SAP. Enquanto pendente, nenhum plano local e fonte oficial e nenhuma contabilizacao pode usar plano apenas local.
