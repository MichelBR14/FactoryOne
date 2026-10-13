# Integração documental das Agent Skills

## Decisão e autorização

Em 13/10/2026, o responsável aprovou exclusivamente a integração documental das Agent Skills ao FactoryOne. A adoção complementa o AGENTS global, preserva o conteúdo anterior de `README.md` e `CLAUDE.md` e não altera contratos técnicos ou contábeis. A autorização é a mensagem “Integração das Agent Skills — FactoryOne”, com seus escopo, regras, limites, validação e encerramento.

O plugin de referência é `agent-skills@agent-skills`, versão 0.6.12 encontrada localmente nesta revisão. A seleção e seus procedimentos estão em [AGENT-SKILLS-WORKFLOW.md](AGENT-SKILLS-WORKFLOW.md). Não se copia o cache do plugin nem se fixa caminho pessoal no projeto.

Alternativas consideradas: executar o ciclo completo do plugin extrapolaria a autorização; substituir as instruções antigas perderia decisões e evidências. A decisão adotada acrescenta regras locais, invariantes e um mapa de estado, mantendo os documentos anteriores intactos e separando prova histórica de autorização vigente.

## Escopo fechado

Criar `AGENTS.md`, `CONSTRAINTS.md`, este documento, `docs/AGENT-SKILLS-WORKFLOW.md`, `docs/FACTORYONE-CURRENT-STATE.md`, `docs/ENVIRONMENTS-AND-AUTHORIZATIONS.md` e `docs/README.md`. Acrescentar somente referências pertinentes e a decisão em `README.md` e `CLAUDE.md`.

Não modificar código, testes, scripts executáveis, migrations, configuração operacional ou evidências. Não instalar dependências, iniciar serviços, acessar SAP Business One, Service Layer, SQL Server ou outro sistema externo, provisionar metadados, movimentar estoque, reavaliar, contabilizar, recuperar ou reconciliar dados. Não ler/divulgar credenciais, executar commit, push ou deploy. Não iniciar fase funcional seguinte.

## Estado Git inicial

Branch: `feature/ggf-v2-absorption`. HEAD: `0786d9e82ade88029f76cab99d914ad9f4794909`. Registro obtido por `git status --short --untracked-files=all`, `git branch --show-current` e `git rev-parse HEAD`, antes das edições. Nenhuma alteração staged apareceu no registro inicial.

```text
 M scripts/ggf-closing-metadata.mjs
 M scripts/ggf-homologation-session.mjs
 M test/ggf/ggfPostingOrchestrator.test.ts
 M test/ggf/ggfPostingPlan.test.ts
 M webapp/modules/ggf/repository/SapGgfClosingRepository.ts
 M webapp/modules/ggf/service/GgfPostingOrchestrator.ts
 M webapp/modules/ggf/service/GgfPostingPlan.ts
?? .vscode/launch.json
?? scripts/ggf-phase7e-homologation.mjs
?? scripts/ggf-phase7e-post-closing-once.mjs
?? scripts/ggf-phase7e-post-cpv-once.mjs
?? scripts/ggf-phase7e-reconcile-existing.mjs
?? scripts/ggf-phase7e-recovery.mjs
?? test/ggf/ggfPhase7EOrderId.test.ts
?? webapp/modules/ggf/service/GgfPhase7EOrderId.ts
```

São 7 arquivos modificados e 8 não versionados preexistentes. Nenhum deles pertence ao escopo de edição desta integração. Não usar checkout, reset, clean, stash, troca de branch ou restauração para “limpar” esse estado.

## Plano e critérios de aceite

| Etapa | Dependência | Entrega | Critério e verificação |
| --- | --- | --- | --- |
| 1. Registrar contexto | Nenhuma | Estado Git, instruções e fontes locais | Ler AGENTS global, CLAUDE completo, README e contratos; registrar baseline de preservação antes de editar. |
| 2. Fixar limites locais | 1 | AGENTS e CONSTRAINTS | Conferir cada invariante contra contratos existentes e autorização; não criar regra contábil nem limite numérico novo. |
| 3. Organizar contexto durável | 2 | Workflow, estado atual e ambientes | Validar nomes reais das skills e referências; separar código presente, evidência histórica, proposta e pendência. |
| 4. Integrar navegação | 3 | Índice, referências e decisão | Todos os documentos criados têm destino autorizado; README e CLAUDE recebem apenas acréscimos. |
| 5. Revisar e encerrar | 4 | Checklist e resultado | Ler integralmente novos documentos e diff; comparar baseline, links, branch/HEAD e instruções anteriores; entregar para revisão sem avançar. |

Checkpoint após etapa 2: confirmar preservação das regras monetárias, FIFO e idempotência. Checkpoint após etapa 4: confirmar cobertura dos nove documentos autorizados. O plano e checklist ficam neste arquivo por determinação do usuário, em substituição aos destinos genéricos `tasks/plan.md` e `tasks/todo.md` da skill de planejamento.

## Checklist de validação

Resultado da revisão documental; nenhuma caixa representa homologação SAP ou aprovação de produção.

- [x] Estado Git inicial registrado, incluindo modificados e não versionados.
- [x] AGENTS global, CLAUDE, README, contratos e skills selecionadas lidos.
- [x] Sete documentos novos e somente dois documentos preexistentes alterados.
- [x] Novos documentos e diff integralmente revisados.
- [x] Conteúdo anterior de README e CLAUDE preservado byte a byte como prefixo.
- [x] Arquivos preexistentes fora do escopo comparados com o baseline.
- [x] Branch, HEAD e alterações locais iniciais preservados.
- [x] Links locais, referências e nomes das skills validados.
- [x] Nenhuma operação SAP, remota ou financeira executada.
- [x] Sem execução de scripts do projeto, serviços, instalação, commit, push ou deploy.
- [x] Resultado, limitações e pendências registrados; documentos disponíveis para revisão.

## Método de preservação e limites da validação

O baseline temporário fora do checkout registra 492 caminhos: arquivos versionados, não versionados não ignorados e evidências locais em `.local/ggf` selecionadas sem arquivos de sessão/credenciais. Conteúdo elegível recebe SHA-256; links simbólicos são comparados pelo destino e arquivos de nomes sensíveis apenas por metadados, sem abrir seu conteúdo. O baseline não é commit nem evidência SAP e não inclui caches, dependências ou todos os arquivos ignorados. A comparação final verifica ausência de mudanças em todos os caminhos registrados fora do escopo; a lista de novas entradas Git deve coincidir com os sete documentos aprovados.

Para README e CLAUDE, conferir que o prefixo anterior ao acréscimo tem o mesmo SHA-256 do baseline. Para alterações preexistentes, a comparação usa os bytes recebidos, não o conteúdo do HEAD, evitando confundir trabalho do usuário com esta entrega. O AGENTS global foi apenas lido.

Links externos históricos não são visitados nesta tarefa. A validação documental usa arquivos locais e existência dos destinos; não revalida o conteúdo de evidências SAP nem certificados, permissões, estado de serviços ou saldos. Testes, lint, typecheck, build e navegador não são executados: não houve mudança de comportamento, e a autorização limita a tarefa à revisão documental. Os resultados desses checks citados nos documentos antigos permanecem históricos.

## Resultado da validação

- Criados: `AGENTS.md`, `CONSTRAINTS.md`, `docs/AGENT-SKILLS-WORKFLOW.md`, `docs/AGENT-SKILLS-INTEGRATION.md`, `docs/FACTORYONE-CURRENT-STATE.md`, `docs/ENVIRONMENTS-AND-AUTHORIZATIONS.md` e `docs/README.md`.
- Alterados: somente `README.md` e `CLAUDE.md`, por acréscimos de referências e decisão. Conteúdo anterior preservado integralmente como prefixo, conferido por SHA-256.
- Preservação: 490 caminhos preexistentes registrados fora do escopo permanecem iguais ao baseline, incluindo os 15 arquivos do estado Git inicial. Branch e HEAD iguais aos iniciais; nenhuma alteração staged criada.
- Referências: 135 links locais nos nove documentos conferidos por existência do destino, sem faltantes; os documentos Markdown da raiz de `docs/` estão indexados. Os 25 nomes da matriz coincidem com arquivos e campo `name` dos SKILL.md da instalação de referência.
- Revisão: leitura integral dos sete novos documentos e do diff de README/CLAUDE; revisão de coerência com os contratos e limites aprovados. `git diff --check` dos documentos versionados e comparação `--no-index --check` dos sete novos documentos sem erro de whitespace.
- Operações: somente leituras locais, edições documentais e verificações locais de conteúdo/preservação. Nenhum acesso SAP/Service Layer/SQL Server/remoto, login, operação financeira, execução de script do projeto, serviço, dependência, commit, push ou deploy. Nenhum arquivo de credenciais foi aberto ou carregado.

Hashes do conteúdo original preservado:

| Arquivo | SHA-256 original |
| --- | --- |
| README.md | `fbbff99140f8e0b1e314e165f2b4c70bd517d4b37ee5b70b80342e2b62d7f418` |
| CLAUDE.md | `6a65998747a36d7d7fcad12a8398beb9fe9c3300c40f517ba2ac785ca04b4293` |

Os limites do baseline e a ausência de revalidação remota estão descritos acima; esta validação não é auditoria funcional das mudanças locais recebidas nem certificação de conteúdo SAP.

## Riscos e pendências

| Questão | Impacto | Tratamento nesta entrega | Decisão futura necessária |
| --- | --- | --- | --- |
| Documentos de fases distintas descrevem estados diferentes | Confundir plano antigo com estado operacional atual | Preservar originais e contextualizar no mapa de estado | Revisão técnica/funcional específica antes de operação. |
| Scripts locais de 7D/7E e resultados ignorados | Código ou arquivo presente pode ser confundido com prova de sucesso | Registrar presença sem executar nem certificar conclusão | Revisão autorizada de evidência sanitizada e reconciliação, se necessária. |
| Defaults genéricos de qualidade do plugin | Criar requisitos sem fundamento ou alterar ferramentas | Não adotar metas de cobertura, desempenho, mutação ou novos scanners | Medição e decisão próprias, em tarefa autorizada. |
| SAP e ambiente não consultados | Estado remoto de 13/10/2026 permanece desconhecido | Evidências identificadas como históricas | Autorização específica para verificação futura. |

## Encerramento

Esta integração termina com entrega documental para revisão. Nenhuma pendência autoriza automaticamente correção técnica, contabilização, homologação, industrialização, publicação ou outra fase.

## Verificação independente de encerramento — 13/10/2026

Os nove documentos aprovados já estavam criados/atualizados no checkout quando a proteção de preservação desta sessão tentou gravar o conteúdo preparado. A gravação foi interrompida antes de alterar arquivos porque o status Git diferia do baseline; os documentos encontrados foram preservados e revisados integralmente, sem substituição ou repetição de seus acréscimos.

A comparação independente usa o estado inicial registrado nesta tarefa: branch feature/ggf-v2-absorption, HEAD 0786d9e82ade88029f76cab99d914ad9f4794909, sete arquivos modificados e oito não versionados preexistentes. Resultado efetivamente verificado:

- Os nove caminhos que passaram a constar como alterados/novos são exatamente os autorizados: sete documentos novos, README e CLAUDE.
- Os bytes originais de README e CLAUDE permanecem intactos como prefixo, com os SHA-256 originais registrados acima.
- Os 279 arquivos versionados/não versionados elegíveis fora do escopo mantêm seus hashes. As sete alterações e os oito arquivos não versionados iniciais foram preservados.
- Os 886 registros de metadados acompanhados em arquivos sensíveis, evidências e artefatos locais permaneceram iguais; nenhum conteúdo de credenciais foi aberto. Esta comparação de metadados não certifica o conteúdo dos arquivos ignorados.
- Branch, HEAD e bytes do índice Git permaneceram iguais; nenhum staging, commit ou push foi feito.
- Os 135 links locais dos nove documentos resolvem para destinos existentes; todos os documentos Markdown da raiz de docs estão indexados. Os 25 identificadores da matriz coincidem com diretórios e campo name dos SKILL.md instalados na versão 0.6.12.
- Diff de README/CLAUDE e conteúdo integral dos sete documentos novos revisados. Verificação de whitespace do diff dos dois arquivos versionados sem erro; arquivos novos sem whitespace final, marcadores de conflito ou falta de newline final.
- Não foram executados aplicação, testes, lint, typecheck, build, scripts do projeto, serviços, instalações, conexões SAP/Service Layer/SQL Server ou outras operações remotas, financeiras ou de publicação.

O relatório anterior de 492/490 caminhos foi encontrado nos documentos e preservado. Seu baseline temporário não foi localizado ou reexecutado por esta verificação; essas contagens não são utilizadas como evidência independente desta sessão. A comprovação aqui é limitada aos hashes, metadados, instruções, links e estado Git acima.

Este complemento registra evidências documentais locais e a mudança de estado encontrada; não atribui autoria à criação anterior dos documentos nem amplia autorizações. As pendências funcionais e os limites de encerramento permanecem vigentes. A tarefa termina com o resultado disponível para revisão, sem iniciar outra atividade.
