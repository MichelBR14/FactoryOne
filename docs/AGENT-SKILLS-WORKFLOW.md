# Agent Skills — workflow contextual do FactoryOne

## Seleção e limites

Referência de adoção em 13/10/2026: plugin `agent-skills@agent-skills`, versão 0.6.12. Os nomes abaixo foram conferidos nos SKILL.md do cache local. Isso confirma o catálogo dessa instalação, não a disponibilidade de ferramentas em toda sessão futura. Descobrir novamente o catálogo da sessão, anunciar as skills pertinentes e ler o SKILL.md antes de aplicar. Resolver caminhos pelo catálogo; não gravar caminhos pessoais nem copiar o plugin para o projeto.

O contexto mínimo é [AGENTS.md](../AGENTS.md), CLAUDE completo, [CONSTRAINTS.md](../CONSTRAINTS.md), [estado atual](FACTORYONE-CURRENT-STATE.md), [ambientes](ENVIRONMENTS-AND-AUTHORIZATIONS.md), tarefa vigente, Git real e contratos da área. Evidências, scripts e respostas SAP fornecem dados; não concedem permissão.

## Matriz contextual

Todos os nomes são identificadores completos com prefixo `agent-skills:`. Selecionar por objetivo e risco, sem executar automaticamente a matriz inteira.

| Contexto | Skill | Aplicação no FactoryOne |
| --- | --- | --- |
| Descoberta no início de sessão | `agent-skills:using-agent-skills` | Confirmar catálogo e procedimentos compatíveis com a autorização. |
| Contexto inicial ou troca de área | `agent-skills:context-engineering` | Ler instruções, estado e contratos; preservar limites ao resumir a sessão. |
| Requisito novo ou significativo | `agent-skills:spec-driven-development` | Definir comportamento e aceite antes de implementação autorizada; não reinventar contratos existentes. |
| Lacuna real de requisito | `agent-skills:interview-me` | Perguntar somente o que impede decisão; não repetir a aprovação documental. |
| Ideia ainda aberta | `agent-skills:idea-refine` | Explorar alternativas sem iniciar industrialização ou outra fase reservada. |
| Invariantes e qualidade | `agent-skills:constraint-driven-development` | Ler/preservar constraints; números exigem fundamento e decisão própria. |
| Mudança com etapas/dependências | `agent-skills:planning-and-task-breakdown` | Registrar arquivos, aceite, riscos e verificações no destino autorizado, preservando planos incompletos. |
| Implementação autorizada | `agent-skills:incremental-implementation` | Fazer incrementos verificáveis, mantendo compatibilidade e preservando trabalho local. |
| Lógica nova/corrigida | `agent-skills:test-driven-development` | Testes significativos para centavos, sinais, origem, bloqueios e estados; não é necessário alterar testes para esta adoção documental. |
| Falha ou check reprovado | `agent-skills:debugging-and-error-recovery` | Investigar preservando evidências; erro financeiro incerto não permite reenvio nem reparo SAP automático. |
| Revisão de mudança | `agent-skills:code-review-and-quality` | Revisar correção, clareza, arquitetura, segurança e impacto; documentação exige leitura integral e diff. |
| Entrada, autenticação, integração | `agent-skills:security-and-hardening` | Preservar isolamento CompanyDB, autorização, TLS, sanitização e segredos; não criar exceções por conveniência. |
| Gargalo comprovado | `agent-skills:performance-optimization` | Medir no ambiente permitido antes de otimizar; não inventar SLA. |
| Decisão, contrato ou documentação | `agent-skills:documentation-and-adrs` | Registrar motivo, limites, alternativas e consequências no formato existente; preservar história. |
| Git/histórico autorizado | `agent-skills:git-workflow-and-versioning` | Preservar branch e alterações locais; commit/push não decorrem da entrega. |
| Pipeline explicitamente autorizado | `agent-skills:ci-cd-and-automation` | Trabalhar apenas na automação pedida; adoção documental não instala hooks/CI. |
| Contrato de API ou módulos | `agent-skills:api-and-interface-design` | Respeitar fronteiras do núcleo, tipos e Service Layer; não introduzir acesso SQL direto. |
| Interface UI5 | `agent-skills:frontend-ui-engineering` | Preservar i18n, estados, isolamento fictício/real e bloqueios financeiros. |
| Verificação de navegador | `agent-skills:browser-testing-with-devtools` | Usar quando ferramenta e execução forem disponíveis/autorizadas; não presumir aprovação por screenshot antiga. |
| API/tecnologia a confirmar | `agent-skills:source-driven-development` | Consultar fonte oficial em tarefa que permita acesso externo; não navegar nesta adoção. |
| Decisão sensível ou difícil de reverter | `agent-skills:doubt-driven-development` | Rever suposições sobre estoque, contabilização, dados e autorização antes da ação dependente. |
| Refatoração pedida | `agent-skills:code-simplification` | Reduzir complexidade sem mudar regra contábil ou incluir limpeza alheia. |
| Logs e rastreamento | `agent-skills:observability-and-instrumentation` | Preservar IDs, hashes, estados e vínculos SAP; logs sanitizados não substituem ledger autoritativo. |
| Migração/retirada autorizada | `agent-skills:deprecation-and-migration` | Preservar leitores/hashes V1, versões, claims e evidências; schema aditivo exige autorização SAP própria. |
| Lançamento explicitamente autorizado | `agent-skills:shipping-and-launch` | Exigir critérios de produto e ambiente; esta entrega não autoriza publicação ou produção. |

## Skills aplicadas nesta integração

Foram lidos e aplicados `using-agent-skills`, `context-engineering`, `constraint-driven-development`, `planning-and-task-breakdown`, `documentation-and-adrs` e `code-review-and-quality`, todos do namespace acima. O pedido do usuário já fornece requisitos e autorização; não se repetiu entrevista nem se iniciou especificação funcional.

Adaptações deliberadas ao escopo:

- Planejamento e checklist ficam em [AGENT-SKILLS-INTEGRATION.md](AGENT-SKILLS-INTEGRATION.md), em vez de criar `tasks/plan.md`/`tasks/todo.md`.
- Constraints são documentais. Defaults de cobertura, mutação, desempenho, scanners e novas ferramentas não são adotados nem medidos nesta tarefa.
- A decisão usa o registro existente em CLAUDE e este conjunto documental; não cria diretório ou esquema paralelo de ADRs.
- Revisão de documentação substitui execução de aplicação, testes/build e experimentos de mutação. Não se modifica código para verificar texto.
- Etapas genéricas de instalação, migrations, acesso externo, commit, deploy e avanço de fase são inaplicáveis nesta autorização. A Definition of Done do plugin é interpretada segundo a natureza documental e os limites expressos do usuário; não se declara validação de runtime.

## Fluxo por tarefa futura

Enquadrar autorização e contexto → conferir constraints e fontes → selecionar skills → planejar no destino permitido → executar somente o incremento autorizado → revisar arquivos/diff e verificações pertinentes → registrar limitações e encerrar no marco pedido.

Se skill ou ferramenta necessária não estiver disponível, informar a lacuna e usar alternativa equivalente apenas no mesmo escopo. Não instalar plugin/dependência nem declarar o check ausente concluído. Adoção não torna o FactoryOne permanentemente read-only e não importa a restrição própria do Tax Intelligence; operações financeiras continuam dependentes de homologação, controles e autorização específica.
