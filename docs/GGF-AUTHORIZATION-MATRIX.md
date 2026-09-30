# GGF: matriz de autorizacoes

## Escopo e estado

Esta matriz define **perfis funcionais**, nao cria usuarios SAP nem libera contabilizacao. O fechamento continua protegido por `ClosingId`, claim unico, versionamento, `PostingHash`, `IntegrityStatus` e bloqueios da aplicacao. Autorizacao SAP e uma camada adicional. Nenhum perfil nesta etapa recebe permissao para criar `MaterialRevaluation` pelo FactoryOne.

Leitura da Service Layer na SBODEMOBR2 em 28/09/2026, antes da alteracao:

| UDO (`Code` / `TableName`) | `Name` | Tipo | `ApplyAuthorization` | `CanDelete` |
| --- | --- | --- | --- | --- |
| `FBO_GGF_CLOSE` | FactoryOne GGF closing | `boud_MasterData` | `tNO` | `tNO` |
| `FBO_GGF_CLINE` | FactoryOne GGF closing line | `boud_MasterData` | `tNO` | `tNO` |
| `FBO_GGF_CLAIM` | FactoryOne GGF posting claim | `boud_MasterData` | `tNO` | `tNO` |

A alteracao autorizada nesta etapa e **somente** `UserObjectsMD('<Code>').ApplyAuthorization: tNO -> tYES`, preservando as demais propriedades e registros. A [Service Layer documenta que PATCH mantem as propriedades omitidas](https://help.sap.com/docs/SAP_BUSINESS_ONE/f110a154dd0f4c20bf7f3ebca9eeb794/54d60024cd4d46f5bf6f8acdb8059f88.html), e [SAP expõe `ApplyAuthorization` em `UserObjectsMD`](https://help.sap.com/doc/2ae9e7a283a44cb082c422a8ab62d98f/10.0/en-US/10.0_FP2208_VS_FP2202.html). A concessao das autorizacoes aos usuarios ocorre em **Autorizações Gerais** do cliente SAP B1, conforme a [documentacao SAP de UDOs](https://help.sap.com/docs/SAP_BUSINESS_ONE/2dc2e07e933b4dd5b93ab6405dcfb6af/fe208b82873745cc8168b055665124ca.html); ativar o campo nao concede automaticamente o perfil desejado.

Em 29/09/2026, a evolucao tecnica FIFO adicionou `FBO_GGF_CVERS` (snapshot de versao) com `ApplyAuthorization=tYES` e `CanDelete=tNO` desde a criacao. Ele deve receber a **mesma restricao de leitura para operador/posting e administracao reservada** dos tres UDOs originais. A atribuicao de usuarios e seu teste continuam pendentes; nenhuma permissao humana foi alterada por esta instalacao.

## Alteracao realizada na SBODEMOBR2

`node scripts/ggf-udo-authorization.mjs plan` registrou o JSON completo dos tres `UserObjectsMD` antes da mudanca em `.local/ggf/ggf-udo-authorization.json` (ignorado pelo Git). O modo `apply` releu e comparou o baseline, enviou **somente** `{ "ApplyAuthorization": "tYES" }` em cada PATCH e recebeu HTTP **204, 204, 204**. GET imediato e GET em **nova sessao** retornaram `tYES` para CLOSE, CLINE e CLAIM; o SHA-256 de todas as outras propriedades permaneceu identico em cada UDO. O modo `verify` repetiu a conferencia posteriormente. Nao houve criacao/edicao de fechamento, linha, claim ou `MaterialRevaluation`.

Depois da ativacao, a sessao tecnica de implantacao obteve HTTP 200 em GET de um registro existente de cada UDO. Nao ha neste workspace credenciais separadas e autorizadas para os papeis operador e posting; portanto **nao foram executados** PATCH negativo por operador nem teste positivo de posting. A atribuicao de permissoes por usuario nas Autorizações Gerais e a prova com sessoes distintas ficam para implantacao. Habilitar `ApplyAuthorization` sozinho nao prova que essas permissoes foram concedidas corretamente.

## Matriz pretendida

| Recurso/acao | `FACTORYONE_GGF_OPERATOR` | `FACTORYONE_GGF_POSTING` | `FACTORYONE_ADMIN` |
| --- | --- | --- | --- |
| Consultar/simular fechamento e memoria | Sim | Sim | Sim |
| GET `FBO_GGF_CLOSE`, `FBO_GGF_CLINE`, `FBO_GGF_CLAIM`, `FBO_GGF_CVERS` | Leitura | Leitura | Total, conforme funcao administrativa |
| Preparar contabilizacao pelo fluxo FactoryOne | Nao | Sim, quando a funcao for liberada | Apenas se tambem autorizado funcionalmente |
| Executar POST financeiro | Nao | **Bloqueado nesta etapa** | **Bloqueado nesta etapa** |
| PATCH direto de header POSTED, linhas contabilizadas ou claim | Nao | Nao | Apenas procedimento excepcional auditado; nao e operacao normal |
| `UserObjectsMD`, `UserFieldsMD`, `UserTablesMD`, atribuicao de autorizacoes | Nao | Nao | Somente implantacao/administracao |
| Remover ou substituir claim/historico | Nao | Nao | Nao como rotina; investigacao formal se necessario |

O SAP oferece autorizacao por UDO, mas nao uma permissao condicional do tipo "pode alterar DRAFT, nunca POSTED" somente com `ApplyAuthorization`. Por isso `FACTORYONE_GGF_OPERATOR` e `FACTORYONE_GGF_POSTING` devem manter **leitura** direta dos tres UDOs. A futura gravacao de header/linhas/claim precisara de uma identidade tecnica restrita ao servico de fechamento, que valide o perfil funcional, o estado, a integridade e a idempotencia antes de qualquer escrita. Esse canal de escrita **ainda nao existe/nao esta liberado**. Nao conceder `Full Authorization` aos usuarios humanos de posting para contornar isso.

## Homologacao de permissoes

Depois de `ApplyAuthorization=tYES`, testar com sessoes reais de usuarios distintos, sem alterar autorizacoes globais para facilitar o teste:

1. Operador: GET dos tres UDOs permitido; PATCH de um **registro tecnico descartavel nao contabilizado** recusado. Nao tentar PATCH em POSTED real.
2. Posting: GET permitido; edicao direta de UDO recusada; autorizacao de preparar no FactoryOne sera testada quando existir o canal confiavel.
3. Administrador: confirmar visibilidade dos UDOs em Autorizações Gerais e capacidade administrativa documentada. Nao editar fechamento POSTED para provar privilegio.

Como nao ha credenciais separadas ja autorizadas na SBODEMOBR2, esta prova por perfil fica para implantacao. Nao criar usuarios ficticios nem reduzir permissoes existentes. Administradores SAP/superusuarios com privilegios suficientes podem alterar UDOs e ate as evidencias do claim; a integridade da aplicacao nao oferece garantia absoluta contra um agente que reescreva todos os registros coerentemente. Incidentes exigem trilha externa e analise administrativa.
