# FactoryOne — invariantes de desenvolvimento e integridade

Revisão documental: 13/10/2026. Este contrato reúne invariantes existentes e as regras aprovadas para a adoção das Agent Skills. Não muda algoritmos, schemas, controles operacionais ou política contábil. Leia antes de escrever código; não o enfraqueça para fazer uma mudança passar.

## Identidade e origem

- Separar CompanyDB, filial/BPLId, período e dimensões de OP, item, depósito, recebimento/linha e camada FIFO. Nenhuma dessas chaves pode substituir outra. DocNum não identifica sozinho uma OP ou documento entre empresas; preservar a chave interna e sua entidade.
- Todo cálculo deve guardar filtros, moeda, unidade, referências de linhas de origem, regra de normalização e comparabilidade, versão e instante de captura. Unidade igual não prova comparabilidade entre produtos. Cadastro atual não prova tarifa histórica.
- Completude exige paginação esgotada, contagem independente e referências conciliáveis no escopo. Não copiar a contagem recebida para fabricar a esperada. Saldo zero só é válido com origem completa comprovada. Leitura não transacional deve manter sua limitação explícita.
- Não substituir base/conta/custo ausente por zero, custo planejado por custo realizado ou hora planejada por apontamento. Filial/dimensões de documento de estoque não substituem automaticamente as da linha contábil.

Fonte: [GGF-SOURCE-CONTRACT.md](docs/GGF-SOURCE-CONTRACT.md), [GGF-READ-MAPPING.md](docs/GGF-READ-MAPPING.md) e [GGF-V2-ABSORPTION-RECONCILIATION.md](docs/GGF-V2-ABSORPTION-RECONCILIATION.md).

## Custo e conservação monetária

- Totais monetários em centavos inteiros, com representação decimal exata nas fronteiras; não somar dinheiro em float. Preservar sinais, inclusive saldo negativo e sobreabsorção.
- O motor existente usa duas casas monetárias, até seis para quantidade/horas e duas para percentuais. Estes limites vêm do contrato vigente, não são metas novas de qualidade.
- Rateio por maior resto fracionário, com desempate estável por identidade de OP/grupo, nunca pela ordem de entrada. Preservar o arredondamento explícito de percentual na fronteira da conta e a conservação em cada nível conta/grupo/OP. Absorção por movimento mantém a regra documentada de meio centavo para longe de zero.
- Categorias MOD/GGF permanecem separadas. `diferença = real contábil elegível - padrão absorvido comprovado`; o padrão absorvido não é somado de novo ao custo real. Componentes/contas sem classificação explícita bloqueiam a conclusão funcional. Não excluir lançamento próprio com base apenas em descrição semelhante.
- No escopo previsto para distribuição, total submetido = total distribuído; parcela não submetida ou bloqueada deve permanecer explícita e conciliada. Por OP, valor alocado = estoque + consumido + não atribuível, conforme contrato aplicável. Diferença interna zero não prova classificação, elegibilidade ou aprovação contábil.
- Total de base zero, base negativa ou base exigida inexistente e percentuais inválidos seguem os bloqueios vigentes; não aplicar rateio igual, ignorar resíduo ou transferir automaticamente para variação. Base individual comprovadamente zero não deve ser confundida com total de base zero. O saldo monetário negativo não equivale a base negativa elegível.

Fonte: [GGF-RATEIO-ENGINE.md](docs/GGF-RATEIO-ENGINE.md), [motor existente](webapp/modules/ggf/engine/allocation.ts), [absorção](docs/GGF-V2-ABSORPTION-RECONCILIATION.md) e [distribuição](docs/GGF-V2-ABSORPTION-DISTRIBUTION.md). As alternativas antigas de CLAUDE são preservadas como história; o README registra a prioridade funcional vigente.

## Estoque e FIFO

- Atribuir estoque por evidência de produção, recebimento, item, depósito, método e camada. Saldo global/agregado não comprova que pertence à OP. Estoque negativo, origem ambígua e múltiplas camadas sem atribuição permanecem bloqueados.
- GGF unitário usa quantidade originalmente produzida elegível, não a quantidade remanescente. O split em centavos preserva estoque + consumido = valor total, com o resíduo na parcela consumida segundo o contrato existente.
- Preservar a trilha OP → recebimento/linha → camada original → movimentos → camada aberta/resultante. Ausência de camada aberta não prova consumo total. Transferência exige conciliar origem/destino e não vira consumo.
- Reavaliação da camada aberta só alcança a quantidade comprovadamente remanescente. Não concentrar todo o ajuste da produção nessa camada quando existe parcela consumida. Uma reavaliação não reescreve por si só o custo histórico do recebimento/OP.
- Média móvel, FIFO, custo padrão e lote/série têm escopos e regras próprios. Prova de um método/cenário não libera outro; custo padrão absorvido de recurso não significa item avaliado por custo padrão.
- Saída/consumo não é automaticamente CPV. Venda, uso em outra OP, perda, ajuste, transferência, retorno e estorno exigem classificação e regra contábil próprias. Parcela não atribuível ou sem regra não pode desaparecer do fechamento.

Fonte: [GGF-MATERIAL-REVALUATION-FIFO.md](docs/GGF-MATERIAL-REVALUATION-FIFO.md), [GGF-V2-STOCK-CONSUMPTION-SPLIT.md](docs/GGF-V2-STOCK-CONSUMPTION-SPLIT.md) e [GGF-MATERIAL-REVALUATION-HOMOLOGATION.md](docs/GGF-MATERIAL-REVALUATION-HOMOLOGATION.md).

## Contabilização e reconciliação

- Nenhum efeito financeiro é autorizado por cálculo, estado `VALIDATED`, fixture, conta técnica, testes ou prova histórica. Requer escopo vigente, regra funcional/contábil aprovada e controles de ambiente.
- Preservar CompanyDB, filial, moeda, período aberto, contas/dimensões efetivas, quantidade, método, preço e valores de cada perna documental. Não inferir conta por descrição nem reutilizar contas técnicas como parametrização produtiva.
- Distinguir `MaterialRevaluation`, `JournalEntry.CPV` e `JournalEntry.Closing`. Reclassificação de fechamento não é um terceiro ajuste econômico somado ao efeito estoque + consumido. Totais esperados/enviados/conciliados do ledger seguem sua própria semântica documental, sem alterar o contrato para coincidir com o total econômico.
- Preservar dependências e ordem do plano aplicável; somente documento reconciliado satisfaz a dependência seguinte. HTTP 201, hash ou equilíbrio débito/crédito isolados não comprovam efeito econômico correto.
- Reconciliação exige documento e diário correspondentes, contas, valores, sinais, dimensões, datas e escopo; para FIFO inclui camada de origem/resultante. Zero ou múltiplos candidatos, paginação incompleta ou fonte indisponível preservam incerteza.
- `Comments`, `JournalMemo`, `Reference1` e marcadores humanos não são chaves únicas de idempotência. Preservar vínculos oficiais por tipo de documento e DocEntry/DocNum/TransId, respeitando que Journal Entry usa JdtNum como chave interna.

Fonte: [GGF-V2-ACCOUNTING-PREVIEW.md](docs/GGF-V2-ACCOUNTING-PREVIEW.md), [GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md](docs/GGF-V2-PHASE-7E.1-ECONOMIC-SCENARIO.md) e [GGF-V2-POSTING-ORCHESTRATION.md](docs/GGF-V2-POSTING-ORCHESTRATION.md).

## Idempotência, estados e integridade

- Preservar ClosingId e versões do fechamento/plano, PostingHash, RequestHash e ExecutionId. A identidade composta de execução é `ClosingId + ClosingVersion + PostingPlanVersion + PostingHash`; a versão operacional mutável do header não substitui a versão imutável vinculada ao plano.
- Hashes usam serialização canônica e campos funcionais do contrato/versionamento correspondente. Timestamps e sessões não entram por conveniência; não incluir/excluir campos nem migrar hashes históricos silenciosamente. Hash detecta divergência de conteúdo, não prova verdade da origem.
- Planos e snapshots históricos são append-only. Header corrente, linhas, CVERS, PPLAN, CLAIM, PEXEC e PDOC têm responsabilidades próprias. Não reinterpretar registros V1 como V2 nem corrigir snapshot por PATCH.
- Claims são permanentes e dependem de unicidade SAP. GET seguido de PATCH não substitui claim atômico. Claim legada por ClosingId bloqueia tentativa nova até reconciliação explícita; não apagar, renomear ou recriar para contornar.
- Preservar estados e transições existentes, inclusive `POSTING_PARTIAL`, `POSTING_UNCERTAIN`, `FAILED`, `PAYLOAD_INTEGRITY_VIOLATION` e estados por documento. Timeout, resposta perdida ou insuficiente não autoriza retry cego. `RECONCILED` nunca é reenviado; `PENDING` exige continuação explicitamente autorizada.
- Persistir intenção, hash de requisição e trilha sanitizada antes de futuro envio conforme contrato. Releitura autoritativa verifica identidade, totais, plano, claim, ledger e documentos; `localStorage` não é autoridade SAP.
- Chamadas UDO separadas não constituem transação única. Escrita parcial ou metadata indisponível mantém bloqueio e requer procedimento próprio; não executar reparo silencioso. Reabrir/cancelar estado local não estorna documento SAP.

Fonte: [GGF-CLOSING-LIFECYCLE.md](docs/GGF-CLOSING-LIFECYCLE.md), [GGF-V2-POSTING-PLAN-PERSISTENCE.md](docs/GGF-V2-POSTING-PLAN-PERSISTENCE.md), [GGF-V2-POSTING-EXECUTION-LEDGER.md](docs/GGF-V2-POSTING-EXECUTION-LEDGER.md) e [orquestrador presente](webapp/modules/ggf/service/GgfPostingOrchestrator.ts).

## Segurança, preservação e qualidade

- Manter integração via Service Layer, isolamento entre empresas, controles de licença/autorização, TLS e proteção de credenciais. Não acessar banco direto, alterar autenticação ou desativar controles para concluir tarefa. Exceção de teste passada não libera exceção futura.
- Preservar todas as alterações locais, arquivos não versionados, instruções, evidências, branch e planos existentes. Não executar Git destrutivo, sobrescrever evidência ou limpar armazenamento para repetir prova financeira.
- Não esconder erro com catch vazio, stub, supressão de tipo/lint, teste removido/skip ou assertion enfraquecida. Critérios existentes só mudam por decisão fundamentada e autorização compatível.
- Não adotar metas novas de cobertura, mutação, latência, tamanho de bundle ou acessibilidade por default de skill. Não há novas ferramentas, hooks ou gates automáticos instalados nesta adoção; estas constraints são documentais e verificadas pela revisão.
- Registrar checks executados, resultados históricos e omissões distintamente. A verificação desta integração é documental: conteúdo, links, diff e preservação. Testes/build/homologação de produção não foram executados nem declarados aprovados.

Fonte: [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md), [GGF-AUTHORIZATION-MATRIX.md](docs/GGF-AUTHORIZATION-MATRIX.md) e [ENVIRONMENTS-AND-AUTHORIZATIONS.md](docs/ENVIRONMENTS-AND-AUTHORIZATIONS.md).
