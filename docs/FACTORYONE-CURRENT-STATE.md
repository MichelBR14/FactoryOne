# FactoryOne — estado atual e alcance das evidências

## Data e conclusão

Revisão local documental em 13/10/2026, na branch `feature/ggf-v2-absorption`, HEAD `0786d9e82ade88029f76cab99d914ad9f4794909`, com alterações locais preexistentes descritas em [AGENT-SKILLS-INTEGRATION.md](AGENT-SKILLS-INTEGRATION.md). O checkout, e não apenas o commit, é a base desta leitura.

Há implementação de cálculo, interface, rastreabilidade, planos e orquestração, além de provas SAP técnicas isoladas registradas. **Não há evidência suficiente nesta revisão para declarar o fechamento GGF geral homologado para produção.** Nenhum serviço, teste, script do projeto ou sistema remoto foi executado nesta integração; números e resultados SAP abaixo pertencem às fontes históricas indicadas.

## Funcionalidades implementadas no checkout

“Implementado” significa código presente e contratos/testes existentes; não significa validação de runtime nesta sessão ou liberação financeira.

| Área | Implementação presente | Alcance e limite |
| --- | --- | --- |
| Núcleo | `webapp/core`: configuração, licença por módulo, cliente Service Layer/sessão, planejador/instalador de metadata, setup/log e utilitário monetário | Testes e relatos históricos não comprovam SSO concreto, permissões de usuários ou implantação atual no Web Client. |
| GGF V1 | [allocation.ts](../webapp/modules/ggf/engine/allocation.ts), contratos de origem, ClosingSession, controller/views, configuração local e CSV | Quatro critérios: custo direto, quantidade produzida, horas apontadas e grupo de recurso. Bases ausentes, incompatibilidade e percentuais inválidos bloqueiam; dados fictícios são separados. |
| Leitura SAP | MappedGgfSource, SapB1ReadMapping, SapB1OrderAudit, SapGgfCalculationSource e scripts de leitura | Seleção explícita e evidências de origem. Não equivale a completude funcional de todos os movimentos/linhas ou elegibilidade contábil do pool. |
| Previa de estoque e FIFO | RevaluationPreview, FifoRevaluationPreview, FifoProductionTrace, FifoRevaluationEvidence e StockConsumptionSplit | Rastreio e candidaturas com bloqueios; saída não vira CPV automaticamente. Demonstrações técnicas não integram por presunção o total funcional. |
| Ciclo persistente | GgfClosing, GgfClosingIntegrity, GgfPostingCoordinator e repositórios CLOSE/CLINE/CLAIM/CVERS | Identidade, versões, hash, integridade e reconciliação. Header corrente e snapshots históricos são diferentes; falha parcial não é transação revertida automaticamente. |
| Absorção V2 | [reconciliation.ts](../webapp/modules/ggf/absorption/reconciliation.ts), [distribution.ts](../webapp/modules/ggf/absorption/distribution.ts), fonte SAP e tela AbsorptionV2 | Real menos padrão absorvido configurado, MOD/GGF separados e distribuição técnica. Conta e tarifa técnica não comprovam classificação/histórico funcional. |
| Prévia e plano V2 | AccountingPreview, GgfPostingPlan, SapGgfPostingPlanRepository | Propostas conceituais e snapshots versionados, com hashes e bloqueios; PPLAN técnico persistido não autoriza contabilização. |
| Execução V2 | [GgfPostingOrchestrator.ts](../webapp/modules/ggf/service/GgfPostingOrchestrator.ts), GgfPostingExecution, stores/repositórios de claim e ledger | Código inclui identidade composta, versão imutável de plano distinta da versão operacional, estados/documentos e recuperação. Provas offline e scripts específicos não habilitam contabilização geral pela interface. |
| Trabalho local 7E | Scripts 7E não versionados, [GgfPhase7EOrderId.ts](../webapp/modules/ggf/service/GgfPhase7EOrderId.ts), teste correspondente e alterações em plano/orquestrador/repositório | Trabalho recebido foi preservado sem revisão funcional completa nem execução. Não é uma entrega técnica desta integração. |

Referências de interface: [navegação](navigation/README.md), [cadastros](ggf-reference-ui/README.md) e [registro visual anterior](ggf-ui/README.md). Screenshots são registros das etapas indicadas, não verificação do navegador em 13/10/2026.

## Provas técnicas históricas documentadas

| Prova e data registrada | Resultado registrado | O que não comprova |
| --- | --- | --- |
| Rateio real V1, fonte em [GGF-REAL-RATEIO-VALIDATION.md](GGF-REAL-RATEIO-VALIDATION.md) | Cálculos selecionados com conferência independente e conta explicitamente técnica | Pool oficial GGF, estoque ou contabilização funcional. |
| Média móvel, 28/09/2026, [homologação](GGF-MATERIAL-REVALUATION-HOMOLOGATION.md) | Um ajuste técnico de R$ 1,00; MaterialRevaluation 25, diário 2278; item/depósito isolados | Regra geral por OP, FIFO/standard/lote/série, estoque compartilhado ou produção. O custo histórico da OP não foi reescrito. |
| FIFO, 29/09/2026, [homologação](GGF-MATERIAL-REVALUATION-FIFO.md) | MaterialRevaluation 30, diário 2282; camada 2789/0 substituída por 2791/0, outra camada preservada; ajuste técnico de R$ 1,00 | Rateio funcional por OP ou CPV. O item desse ensaio não foi produzido por OP. |
| Produção FIFO parcial, 29/09/2026, [split](GGF-V2-STOCK-CONSUMPTION-SPLIT.md) | OP DocEntry 214/número 83; recebimento 122/0, saída 90/0, camada 2792/0; 10 produzidas, 6 saídas e 4 abertas | Destino contábil da saída técnica. Exemplo R$ 100,00 → R$ 40,00/R$ 60,00 é matemática separada, não conta GGF ou CPV aprovado. |
| Ciclo e snapshots, setembro/2026, [lifecycle](GGF-CLOSING-LIFECYCLE.md) | Gravação/releitura técnica, versões e hashes; exposição UDO apresentou instabilidade | Transação única entre registros, estabilidade permanente ou liberação para produção. |
| Absorção/distribuição, 30/09/2026, [conciliação](GGF-V2-ABSORPTION-RECONCILIATION.md) e [distribuição](GGF-V2-ABSORPTION-DISTRIBUTION.md) | MOD -300.000 centavos bloqueados sem conta; GGF -616.600 distribuídos tecnicamente; reproduções aritméticas | Conta de consultoria como GGF funcional ou tarifa CostN atual como histórica. Setembro estava aberto na captura. |
| PPLAN, 01/10/2026, [persistência](GGF-V2-POSTING-PLAN-PERSISTENCE.md) | UDO v3, snapshot SAP técnico `BLOCKED`, releitura/hash em sessões independentes e provas temporais de exposição | Claim financeiro, plano apto para produção ou concorrência de criação homologada; houve limitação de login simultâneo registrada. |
| Ledger 7B, 01/10/2026, [ledger](GGF-V2-POSTING-EXECUTION-LEDGER.md) | Tentativa inicial de instalação aditiva parou por exposição inconsistente, antes de atualizar versão | Não concluir que todos os estados posteriores permanecem nessa falha; a mesma fonte registra prova 7C posterior com round-trip. |
| CPV técnico 7C, 01/10/2026, [ledger](GGF-V2-POSTING-EXECUTION-LEDGER.md) | Um Journal Entry de R$ 1,00, JdtNum 2307/Number 1929; closing/claim/execution POSTED e PDOC RECONCILED em nova sessão; resume sem reenvio | CPV funcional de qualquer saída/OP, ciclo completo estoque + CPV + fechamento ou autorização para novo documento. |

As exceções TLS locais de algumas provas de 01/10 foram explicitamente limitadas àqueles cenários. Não demonstram certificado válido hoje nem permitem repetir bypass. Quantidades, saldos, períodos e estados desses registros não foram relidos em 13/10/2026.

## Propostas, modelos e trabalho não certificado

- [GGF-V2-MIGRATION-PLAN.md](GGF-V2-MIGRATION-PLAN.md) é proposta arquitetural. Etapas posteriores implementam partes, mas o plano inteiro não é prova de conclusão funcional.
- [GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md](GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md) registra modelo offline `PHASE7E_TECHNICAL`: efeito econômico R$ 2,00, estoque R$ 1,00 e consumido R$ 1,00, fechamento como reclassificação. Valores, contas e camada são fixture/allowlist técnica, não parametrização produtiva.
- Existem [script 7D](../scripts/ggf-phase7d-homologation.mjs) e scripts 7E de homologação, recuperação, reconciliação e envio único. Foram observados os nomes dos arquivos locais `phase7d-result.json` e `phase7e-cpv-once-C2B8A14D73-result.json` em `.local/ggf`; seu conteúdo não foi certificado nesta revisão. Presença de script/resultado não comprova que o ciclo terminou ou que todas as pernas estão reconciliadas. Não declarar 7D/7E concluídas nem presumir ausência de documentos anteriores.
- Os scripts 7E recebidos incluem caminhos de escrita SAP e reparo de ledger. Não são executáveis como parte da validação documental e não estão autorizados por esta integração.
- Industrialização permanece escopo futuro reservado em CLAUDE. Não há entrega funcional do módulo `ind` nesta adoção.

## Divergências históricas preservadas

README e CLAUDE conservam textos de fases anteriores que dizem “ainda não implementado”, “nenhum gateway” ou listam pendências posteriormente testadas em cenário técnico. Interpretar cada frase no escopo de sua etapa e verificar a fonte posterior pertinente; não apagar história nem extrapolar uma prova pontual para regra geral.

CLAUDE registra alternativas antigas como `EQUAL`, resíduo/variação e regra inicial de média móvel. O README já estabelece a prioridade funcional dos quatro critérios e bloqueios atuais. Esta adoção referencia essa decisão existente, sem substituir contratos ou selecionar regra contábil nova.

Há divergência entre a descrição histórica de build/scaffold no README/CLAUDE e o `package.json` atual: `build` chama UI5, `build_old` chama `mbt build`, `start` chama Fiori e existem scripts `deploy`/`deploy-config`. O arquivo atual inclui ferramental SAP UX mencionado como ausente na decisão histórica. Nenhuma configuração foi modificada, nenhum desses comandos executado e nenhum formato de implantação foi validado aqui. A futura tarefa de empacotamento deve esclarecer essa divergência antes de alterar ou publicar.

## Pendências para conclusão funcional e produção

| Pendência | Evidência/impacto | Decisão ou prova necessária |
| --- | --- | --- |
| Pool e absorção MOD/GGF | Conta técnica, componentes incompletos e CostN atual não provam competência histórica | Controladoria aprovar contas/componentes, histórico, moeda, filtros e regra de dupla absorção. |
| Bases elegíveis e completude | Horas reais não comprovadas; produtos/unidades podem ser incompatíveis; contagens de cabeçalhos não provam todas as linhas | Origem normalizada, período controlado e conferência independente suficiente. |
| Estoque por OP/camada | OPs 76/77/79 tinham saldo ambíguo/negativo; múltiplas entradas/transferências exigem rastreio composto | Política por método e provas completas de quantidade, camada e destino. |
| Parcela consumida e fechamento | Consumo técnico não é venda/CPV; reclassificação 7E.1 é modelo separado | Aprovação de contas, operações elegíveis, dimensões, datas, sinal, contrapartidas e reversão. |
| Persistência, concorrência e permissões | Exposição UDO oscilou; provas limitadas; ApplyAuthorization não prova usuários | Verificação autorizada multi-sessão/concorrência e por perfil, preservando claims e versões. |
| Estado dos ensaios recentes | 7D/7E têm scripts/resultados locais sem certificação nesta revisão | Revisão específica das evidências sanitizadas; reconciliação ou continuação somente se autorizadas. |
| Implantação e núcleo operacional | SSO concreto, licenças, autorizações e pacote/Web Client carecem de prova suficiente neste conjunto | Homologação autorizada do ciclo real, sem inferir sucesso por `.mtar` ou testes fakes. |

Essas pendências informam o estado; não compõem uma nova fase autorizada. A integração termina com documentação disponível para revisão.
