# FactoryOne — índice documental

Comece pelas instruções locais e pelo mapa de estado. Os contratos e relatos históricos permanecem nos arquivos originais; seus resultados valem para o cenário e data registrados, sem conceder autorização para novas operações SAP.

## Instruções e adoção das Agent Skills

| Documento | Uso |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | Regras locais complementares ao AGENTS global. |
| [CLAUDE.md](../CLAUDE.md) | Especificação, premissas e decisões anteriores preservadas. |
| [README.md do projeto](../README.md) | Orientações e registros históricos da entrega; conferir comando atual antes de executar. |
| [CONSTRAINTS.md](../CONSTRAINTS.md) | Invariantes de custo, estoque, FIFO, contabilização, integridade e preservação. |
| [AGENT-SKILLS-WORKFLOW.md](AGENT-SKILLS-WORKFLOW.md) | Matriz contextual das skills e adaptações ao escopo. |
| [AGENT-SKILLS-INTEGRATION.md](AGENT-SKILLS-INTEGRATION.md) | Decisão de 13/10/2026, autorização, Git inicial, plano, checklist e validação. |
| [FACTORYONE-CURRENT-STATE.md](FACTORYONE-CURRENT-STATE.md) | Implementação presente, provas históricas, propostas, divergências e pendências. |
| [ENVIRONMENTS-AND-AUTHORIZATIONS.md](ENVIRONMENTS-AND-AUTHORIZATIONS.md) | Ambientes, efeitos de operações e autorização necessária. |

## Origem, cálculo e diagnóstico GGF

| Documento | Uso |
| --- | --- |
| [GGF-SOURCE-CONTRACT.md](GGF-SOURCE-CONTRACT.md) | Normalização, comparabilidade, moeda, origem e completude. |
| [GGF-READ-MAPPING.md](GGF-READ-MAPPING.md) | Fontes SAP comprovadas e limites de leitura. |
| [GGF-SAP-READ-VERIFICATION.md](GGF-SAP-READ-VERIFICATION.md) | Conferência técnica das leituras. |
| [GGF-ORDER-BASIS-AUDIT.md](GGF-ORDER-BASIS-AUDIT.md) | Bases por OP e limitações do custo/horas. |
| [GGF-FUNCTIONAL-DIAGNOSTIC.md](GGF-FUNCTIONAL-DIAGNOSTIC.md) | Composição, contas e risco de dupla absorção. |
| [GGF-RATEIO-ENGINE.md](GGF-RATEIO-ENGINE.md) | Critérios, percentuais, arredondamento e bloqueios. |
| [GGF-REAL-RATEIO-VALIDATION.md](GGF-REAL-RATEIO-VALIDATION.md) | Provas matemáticas reais com limites funcionais. |

## Estoque, FIFO e ciclo persistente

| Documento | Uso |
| --- | --- |
| [GGF-INVENTORY-REVALUATION.md](GGF-INVENTORY-REVALUATION.md) | Prévia e requisitos de reavaliação. |
| [GGF-MATERIAL-REVALUATION-HOMOLOGATION.md](GGF-MATERIAL-REVALUATION-HOMOLOGATION.md) | Prova histórica isolada de média móvel. |
| [GGF-MATERIAL-REVALUATION-FIFO.md](GGF-MATERIAL-REVALUATION-FIFO.md) | Prova histórica FIFO e rastreio da produção parcialmente consumida. |
| [GGF-CLOSING-LIFECYCLE.md](GGF-CLOSING-LIFECYCLE.md) | ClosingId, versões, hashes, claims, estados e reconciliação. |
| [GGF-AUTHORIZATION-MATRIX.md](GGF-AUTHORIZATION-MATRIX.md) | Perfis e limites das autorizações SAP/FactoryOne. |
| [SAP-UDO-SERVICE-LAYER-STABILITY.md](SAP-UDO-SERVICE-LAYER-STABILITY.md) | Histórico de exposição/estabilidade UDO e bloqueios. |

## Absorção e execução V2

| Documento | Uso |
| --- | --- |
| [GGF-V2-MIGRATION-PLAN.md](GGF-V2-MIGRATION-PLAN.md) | Proposta arquitetural de migração e suas dependências. |
| [GGF-V2-ABSORPTION-RECONCILIATION.md](GGF-V2-ABSORPTION-RECONCILIATION.md) | Real menos padrão absorvido e prova técnica. |
| [GGF-V2-ABSORPTION-DISTRIBUTION.md](GGF-V2-ABSORPTION-DISTRIBUTION.md) | Distribuição técnica MOD/GGF e bloqueios por categoria. |
| [GGF-V2-STOCK-CONSUMPTION-SPLIT.md](GGF-V2-STOCK-CONSUMPTION-SPLIT.md) | Quantidade originalmente produzida, estoque e consumo sem CPV presumido. |
| [GGF-V2-ACCOUNTING-PREVIEW.md](GGF-V2-ACCOUNTING-PREVIEW.md) | Efeitos conceituais, contas/dimensões e payloads nulos. |
| [GGF-V2-POSTING-PLAN.md](GGF-V2-POSTING-PLAN.md) | Identidade e hash do plano; prova inicial local. |
| [GGF-V2-POSTING-PLAN-PERSISTENCE.md](GGF-V2-POSTING-PLAN-PERSISTENCE.md) | PPLAN SAP append-only e homologação técnica limitada. |
| [GGF-V2-POSTING-ORCHESTRATION.md](GGF-V2-POSTING-ORCHESTRATION.md) | Pré-condições, ordem, estados e limites de orquestração. |
| [GGF-V2-POSTING-EXECUTION-LEDGER.md](GGF-V2-POSTING-EXECUTION-LEDGER.md) | Identidade composta, PEXEC/PDOC, migração e prova CPV 7C posterior. |
| [GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md](GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md) | Modelo offline da reclassificação econômica 7E.1. |

## Interface e registros visuais

- [navigation/README.md](navigation/README.md): navegação e limites do Web Client.
- [ggf-reference-ui/README.md](ggf-reference-ui/README.md): listas/detalhes dos cadastros.
- [ggf-ui/README.md](ggf-ui/README.md): capturas da etapa anterior do assistente.

Evidências locais ignoradas permanecem em `.local/ggf`; consultar somente em tarefa autorizada, com sanitização e escopo apropriados. Nenhuma evidência foi movida, reescrita ou incluída no Git por esta adoção. Industrialização permanece reservada no CLAUDE, sem fase funcional iniciada.
