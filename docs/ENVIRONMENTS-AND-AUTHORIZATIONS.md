# FactoryOne — ambientes, operações e autorizações

## Regra de enquadramento

Classificar uma operação pelo destino e efeitos reais antes de executar. Identificar CompanyDB, filial, período, usuário/perfil, entidades, dados e finalidade sem expor segredos. `localhost`, `dev/test`, nome demo ou credencial disponível não provam isolamento ou autorização.

Este documento complementa [CLAUDE.md](../CLAUDE.md), [AGENTS.md](../AGENTS.md) e a [matriz funcional GGF](GGF-AUTHORIZATION-MATRIX.md). Não concede permissões SAP nem altera as travas da aplicação. A autorização de 13/10/2026 permite somente os nove documentos listados em [AGENT-SKILLS-INTEGRATION.md](AGENT-SKILLS-INTEGRATION.md).

## Classificação de ambientes

| Ambiente | Caracterização | Conduta e autorização |
| --- | --- | --- |
| Checkout local offline | Arquivos do repositório, sem serviços nem conexão | Leitura documental e edição dos arquivos autorizados permitidas nesta entrega; preservar branch, evidências e trabalho local. |
| Demonstração fictícia local | Fixtures `DEV-*`, navegador/localStorage, modo development | Dados fictícios não provam operação SAP. Iniciar serviço, executar navegador ou limpar armazenamento está fora desta adoção. |
| Preview local com fonte SAP | Processo local conectado à Service Layer | É acesso remoto apesar da URL local. Leitura, login/logout, actions e arquivos gerados exigem escopo compatível; proibidos nesta entrega. |
| SAP de testes/homologação | `SBODEMOBR2` nas provas históricas | Tratar dados persistidos, documentos financeiros e evidências como existentes e sensíveis. Toda nova operação requer autorização da finalidade e efeito; base não é descartável. |
| Demonstração com dados/serviços de cliente | Ambiente operacional usado por cliente ou apresentação | Não equiparar a fixture nem localhost; preservar disponibilidade e dados, com autorização específica para operações. Nenhum destino concreto foi verificado nesta tarefa. |
| Produção | Empresa e serviços operacionais | Alteração requer autorização própria, controles funcionais/SAP e critérios de liberação. Fechamento GGF geral não está declarado homologado. Nenhum acesso nesta adoção. |
| Ambiente desconhecido | Destino/configuração não confirmado | Não executar ação dependente; esclarecer identidade e efeitos sem ler segredos por conveniência. |

Não foi verificada a configuração atual de nenhum destino. CompanyDB não é filial: a filial 1 das provas é uma dimensão interna da SBODEMOBR2, não autorização sobre outras empresas, períodos, OPs, itens, depósitos ou camadas.

## Operações e escopo necessário

| Operação | Efeitos possíveis | Autorização e situação nesta entrega |
| --- | --- | --- |
| Ler documentos/código local não sensível; status/diff Git | Consulta local | Permitido para sustentar e revisar a documentação. |
| Criar/editar documentos aprovados | Escrita local restrita | Permitido exclusivamente nos nove caminhos autorizados. |
| Teste, lint, typecheck, build, navegador | Execução de código, caches, artefatos, downloads ou serviços conforme comando | Não executados; mudança documental valida conteúdo, links e preservação. Inspecionar scripts/configuração antes de futura execução. |
| Instalar dependência/plugin ou alterar configuração operacional | Escrita em ferramentas, lockfiles, ambiente | Não autorizado. Não inferir permissão de recomendações de skill. |
| Consulta SAP/Service Layer e controle de sessão | Rede, login/logout, logs e eventuais capturas locais | Não autorizado nesta adoção, mesmo quando não altera negócio. |
| Action SAP via POST usada para consulta | Pode ser somente leitura de negócio em contrato específico | Validar contrato e adaptador, não só verbo HTTP. Continua proibida nesta adoção. |
| Provisionar UDT/UDF/UDO/SQLQueries ou permissões | Metadata, versão instalada e acesso de usuários | Exige aprovação própria de schema/ambiente/administração. Não autorizado. |
| Persistir fechamento/plano/claim/execução | UDOs, estados, versões e barreira de envio | É escrita SAP mesmo sem documento financeiro; exige autorização específica. Não autorizado. |
| Criar/alterar item, BOM, OP, recebimento, saída ou transferência | Cadastros, estoque e possível diário | Exige cenário e limites explicitamente aprovados. Preparação técnica não é neutra. Não autorizado. |
| MaterialRevaluation, Journal Entry CPV/fechamento/estorno | Custo, estoque, contabilidade e histórico | Exige regra aprovada, preflight, plano/hashes, claim, ledger e reconciliação; uma prova passada não autoriza repetição. Não autorizado. |
| Recuperação, reconciliação ou retomada | Pode ler SAP, atualizar ledger/claim/header e enviar documentos pendentes | Revisar código/dependências e autorizar os efeitos exatos. Não autorizado, inclusive para “corrigir só estado”. |
| Git commit/push, publicação ou deploy | Histórico, remoto e/ou ambiente operacional | Fora desta autorização; terminar com documentos disponíveis para revisão. |

## Scripts e efeitos que não podem ser presumidos

As referências abaixo servem para classificação, não para execução:

- [ggf-closing-metadata.mjs](../scripts/ggf-closing-metadata.mjs) contém caminhos de metadata; planejamento e instalação são efeitos distintos. Ambos exigem examinar o modo e dependências antes de futura execução.
- [ggf-homologation-session.mjs](../scripts/ggf-homologation-session.mjs) é fronteira de sessão usada por provas, inclusive métodos de escrita técnica. Não é simples leitor de arquivos.
- [ggf-phase7e-reconcile-existing.mjs](../scripts/ggf-phase7e-reconcile-existing.mjs) abre sessão de escrita e contém `patchTechnicalPhase7ERecord` para alinhar totais/estado de `FBO_GGF_PEXEC`. Seu nome não implica somente leitura.
- [ggf-phase7e-recovery.mjs](../scripts/ggf-phase7e-recovery.mjs), [ggf-phase7e-post-cpv-once.mjs](../scripts/ggf-phase7e-post-cpv-once.mjs) e [ggf-phase7e-post-closing-once.mjs](../scripts/ggf-phase7e-post-closing-once.mjs) pertencem a recuperação/continuação técnica; não devem ser chamados para completar documentação.
- [ggf-phase7e-homologation.mjs](../scripts/ggf-phase7e-homologation.mjs), [ggf-phase7c-homologation.mjs](../scripts/ggf-phase7c-homologation.mjs) e [ggf-phase7d-homologation.mjs](../scripts/ggf-phase7d-homologation.mjs) descrevem provas com efeitos reais. A presença de guards/allowlists não é autorização nova.

Leitura via action FIFO pode usar POST sem criar documento, conforme [GGF-MATERIAL-REVALUATION-FIFO.md](GGF-MATERIAL-REVALUATION-FIFO.md). Inversamente, um fluxo de reconciliação pode atualizar UDO mesmo sem novo POST financeiro. Examinar toda a cadeia é necessário.

## Credenciais, TLS e permissões

Não abrir/carregar `.env`, arquivos de sessão, cookies ou chaves privadas nesta tarefa. Evidências e logs devem excluir credenciais; não publicar conteúdo bruto indiscriminadamente. A revisão documental usa contratos existentes e inspeção local não sensível.

CLAUDE registra que a trava `FBO_ENV=dev/test` protege ferramentas por credenciais, enquanto a sessão SSO do Web Client segue o fluxo normal do cliente. Preservar essa distinção e seus controles: ela não autoriza escrita agora, não substitui aprovação funcional e não torna uma base demo descartável. A restrição permanente read-only do Tax Intelligence não é regra global do FactoryOne.

As exceções TLS históricas são locais, escopadas e vinculadas à autorização daquela prova. Não herdar nem ampliar bypass, não usar HTTP ou desativação global de verificação. Certificado e sessão atuais não foram consultados. `ApplyAuthorization=tYES` não comprova a concessão correta por usuário; a [matriz GGF](GGF-AUTHORIZATION-MATRIX.md) mantém testes por perfil como pendência.

## Critério para autorização futura

Quando uma ação futura estiver fora do escopo vigente, a aprovação deve identificar ambiente/CompanyDB, finalidade, operação, entidades e limites, período/filial e cenário, plano/versões/hashes quando aplicável, procedimento de reconciliação e ponto de parada. Reutilizar autorização já concedida somente dentro desses limites; não pedir de novo por rotina, nem ampliar por inferência.

Antes de operação financeira futura, a regra contábil e a rastreabilidade precisam estar comprovadas. Dúvida crítica de identidade, conta, valor, estoque, metadata ou resultado anterior bloqueia a ação dependente. Nova autorização não dispensa essas invariantes. A presente tarefa encerra após a integração documental.
