# GGF V2 — Plano de Contabilização

## Escopo da Fase 5

A etapa 7 converte a prévia contábil em um plano versionado e auditável. O plano descreve efeitos futuros; não monta payloads da Service Layer, não cria claim, não chama repositórios SAP de escrita e não habilita POST. Cada documento e cada plano mantêm `payload: null`/`postingBlocked: true`.

Esta prova usa `localStorage` do navegador de desenvolvimento em modo append-only, com verificação SHA-256 e releitura após gravação. Isso demonstra persistência local entre recargas, mas não é persistência corporativa no SAP nem proteção contra alteração privilegiada do perfil do navegador. Não gravar o plano na SBODEMOBR2 é intencional: a prova SAP desta fase é exclusivamente de leitura. A futura persistência SAP exige autorização e escolha de schema/UDO antes de qualquer escrita.

## Identidade e versionamento

O cenário técnico usa um `ClosingId` determinístico `TECH-<CompanyDB>-<AAAAMM>`, por exemplo `TECH-SBODEMOBR2-202609`. Esse identificador pertence apenas ao repositório local do FactoryOne; não é um fechamento SAP nem um `Code` já reservado nos UDOs. Cada execução chama `append`, escolhe `Version = maior versão + 1`, acrescenta um snapshot e relê todas as versões. Uma versão já gravada nunca é sobrescrita.

O repositório guarda JSON sob a chave `factoryone.ggf.v2.posting-plans`. JSON inválido, versão repetida, hash ausente ou conteúdo divergente interrompe a releitura com erro. Erro de quota/gravação fica visível na tela e o plano não é apresentado como persistido. A limpeza do armazenamento do navegador remove o histórico; exportação/backup e persistência multiusuário ainda não fazem parte desta fase.

## Estrutura

`GgfPostingPlan` contém:

- `ClosingId`, `Version`, `PostingHash`, `CreatedAt`, `Status`;
- empresa, período, filial, dimensões, moeda e origem do campo de moeda;
- `TotalMod`, `TotalGgf`, `TotalStock`, `TotalCpv`, `TotalBlocked` e diferença de conciliação;
- linhas de auditoria por OP/item/categoria com conta de origem, critério, quantidade/unidade, valor, split estoque/consumido, método, dimensões, contas de débito/crédito por efeito, documentos futuros, bloqueios e referências de origem;
- documentos previstos, cada qual com tipo, ordem, valor total assinado em centavos, moeda, linhas, dimensões, status, bloqueios, dependências e `payload: null`;
- `sourceMode = SAP_READ_ONLY`, horário da leitura e `postingBlocked = true`.

As famílias previstas são `MaterialRevaluation`, `JournalEntry.CPV` e `JournalEntry.Closing`. Quantidade de documentos SAP futuros não é fixada: agrupamento real por item, depósito, contas, moeda, filial/dimensões e política contábil ainda depende de homologação. Linhas de fechamento agregadas preservam referências às OPs contribuintes.

## Hash funcional

`calculateGgfPostingPlanHash` usa SHA-256 sobre JSON canônico. O hash cobre identidade, versão, empresa/período/filial/dimensões/moeda, status e totais, todas as linhas e documentos, incluindo contas, OP/item, critério, quantidade, método de avaliação, split, destino, documentos, dimensões, dependências, bloqueios e referências. `CreatedAt`, instante de captura (`sourceCapturedAt`) e o próprio hash são excluídos. Token, cookie ou sessão não são coletados pelo plano.

Ao ler o repositório, o hash é recalculado para cada versão. Qualquer edição local de conteúdo funcional provoca falha fechada. Uma reexecução do cálculo cria versão nova e hash recalculado, preservando as anteriores.

## Estados e bloqueios

- `DRAFT`: reservado para edição de uma minuta não validada; esta tela não promove plano a rascunho persistido.
- `VALIDATED`: totais conciliados, linhas e documentos previstos sem bloqueios.
- `READY_TO_POST`: estado permitido somente por `canMarkGgfPostingPlanReady` quando não há bloqueios nem diferenças. A interface não executa essa transição e não possui botão POST; nenhum POST financeiro faz parte da Fase 5.
- `BLOCKED`: qualquer linha bloqueada, valor bloqueado, diferença matemática/contábil, documento obrigatório ausente/desbalanceado, ausência de moeda ou documento sem rastreio de OP.

Qualquer linha em bloqueio força o status global `BLOCKED`, mesmo que a conciliação em centavos feche. Quando existe valor bloqueado e o destino entre estoque/CPV não está determinado, as famílias documentais ficam `BLOCKED` (não `NOT_REQUIRED`) e não recebem linhas financeiras fictícias.

## Moeda e prova SAP

A moeda vem de `CompanyService_GetAdminInfo.LocalCurrency`, por GET. A leitura de homologação retornou `R$`; o plano preserva esse valor e a referência do campo, sem inferir um código ISO diferente. Se a propriedade não puder ser lida, `CURRENCY_UNRESOLVED` bloqueia o plano.

Na apuração atual de setembro/2026 com OPs 76, 77 e 79, a reconciliação técnica anterior apresentou MOD de -300.000 centavos sem conta mapeada e GGF de -616.600 centavos com a conta `4.01.01.04.07`, usada somente para validação técnica e não aprovada como GGF funcional. OP 76/C00003 tem saldo agregado sem vínculo comprovado à camada/OP; OPs 77/79 compartilham saldo -11 no depósito 01. A determinação avançada de contas de estoque não foi resolvida. O plano técnico local foi gravado como versão 1 de `TECH-SBODEMOBR2-202609`, hash `bef780c754cb40c8305db630f844f57f622b1966c743c914249fadbaff93a5be`, status `BLOCKED`, moeda `R$` (`CompanyService_GetAdminInfo.LocalCurrency`). Totais: MOD -300.000, GGF -616.600, estoque 0, CPV 0, bloqueado -916.600 centavos e diferença 0. Os três tipos de documento estão bloqueados por destino não determinado, sem linhas e com payload nulo. Uma nova sessão de navegador releu a versão local e o mesmo hash, e a tela reabriu a etapa 7 sem nova consulta SAP. Nenhum dado foi gravado no SAP. A soma matemática fechada não declara o processo funcionalmente validado.

A captura real não grava UDO, claim ou documento no SAP. Persistência corporativa multiusuário deverá ser desenhada sobre armazenamento SAP nativo adotado pelo FactoryOne, com schema/permissões/versionamento revisados e uma etapa futura explicitamente autorizada. Não reutilizar `Reference1` ou `JournalMemo` como chave do plano.

## Interface

A etapa `7. Plano de Contabilização` mostra status, identidade técnica, versão, hash, totais, moeda, documentos e linhas de auditoria. Mostra também histórico local por versão e os bloqueios. O texto informa que o plano é local e que o SAP permanece somente leitura. Não há botão Contabilizar, nem criação de claim.

## Testes

`test/ggf/ggfPostingPlan.test.ts` cobre plano validado, plano bloqueado, alteração de valor, alteração de conta, preservação de versões, bloqueio de `READY_TO_POST`, divergência de totais, adulteração no armazenamento local e exclusão de timestamps voláteis do hash. Playwright verifica a etapa 7, status bloqueado e ausência de criação/claim em viewport desktop e mobile.
