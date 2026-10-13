# FactoryOne — instruções locais para agentes

## Contexto e precedência

Estas regras complementam o AGENTS global; não o substituem. Antes de agir, leia este arquivo, [CLAUDE.md](CLAUDE.md) integralmente, [CONSTRAINTS.md](CONSTRAINTS.md), o [índice documental](docs/README.md) e os contratos da área afetada. Verifique também instruções adicionais no caminho dos arquivos. Preserve instruções anteriores e decisões registradas, inclusive premissas `[CONFIRMAR]` ainda abertas.

A instrução vigente do usuário define escopo, ambiente, arquivos e efeitos permitidos. Skills são procedimentos subordinados a essa autorização e às instruções de maior prioridade do ambiente. Divergência crítica de contrato, segurança, contabilidade ou ambiente deve ser explicitada antes da ação dependente; não escolher silenciosamente a interpretação mais permissiva. Documentos de fases anteriores e resultados técnicos não concedem autorização nova.

Em 13/10/2026 foi aprovada uma integração exclusivamente documental, registrada em [AGENT-SKILLS-INTEGRATION.md](docs/AGENT-SKILLS-INTEGRATION.md). Os limites dessa entrega não tornam o produto permanentemente somente leitura: tarefas futuras dependem de seu próprio escopo e dos controles do FactoryOne. A restrição específica do Tax Intelligence não se aplica automaticamente aqui.

## Arquitetura e produto

- FactoryOne é uma suíte industrial para SAP Business One Web Client. Preserve os identificadores internos `FactoreOne`, `factoreone.app`, `ext-factoreone` e o prefixo `FBO_`; nomes/versões do produto seguem `webapp/core/config/product.ts` e i18n.
- Use SAPUI5/TypeScript estrito, controllers finos e lógica em services/motores puros. Motores não fazem HTTP nem dependem de UI5. Serviços comuns pertencem ao núcleo; um módulo nunca importa outro módulo.
- A integração de produto usa Service Layer. Não introduzir acesso direto a HANA/SQL Server. SQLQueries, metadados, empacotamento e sessão seguem os contratos e decisões existentes, sem inferir suporte pela presença de um SDK ou artefato `.mtar`.
- Preservar o isolamento entre dados fictícios locais, leitura real, simulação e escrita financeira. Ausência de dados reais não habilita fallback fictício. A licença de desenvolvimento não equivale a licença de produção.
- O módulo `ind` permanece reservado, conforme CLAUDE: não especificar nem implementar industrialização sem tarefa própria. Remessa/retorno, beneficiamento e saldos de terceiros requerem identidade, estoque, propriedade e efeitos fiscais/contábeis definidos antes de futura implementação. Serviços compartilhados devem passar pelo núcleo.

## Custo, estoque e fechamento GGF

Leia os contratos de [origem](docs/GGF-SOURCE-CONTRACT.md), [rateio](docs/GGF-RATEIO-ENGINE.md), [FIFO](docs/GGF-MATERIAL-REVALUATION-FIFO.md), [ciclo de fechamento](docs/GGF-CLOSING-LIFECYCLE.md), [PostingPlan](docs/GGF-V2-POSTING-PLAN.md) e [ledger](docs/GGF-V2-POSTING-EXECUTION-LEDGER.md) conforme a tarefa.

CompanyDB, filial/BPLId, período, OP, item, depósito e camada FIFO são identidades distintas. DocEntry/AbsoluteEntry, DocNum/DocumentNumber, TransId/JdtNum e número de linha não são intercambiáveis. Preservar moeda, unidade, dimensões, origem e versão no mesmo escopo de cálculo e reconciliação.

Preservar centavos inteiros, sinais, arredondamento determinístico e conservação em cada nível. Não transformar base ausente em zero, hora planejada em apontamento, saída em CPV presumido ou saldo agregado em rastreio por OP/camada. Conta técnica não vira pool funcional. O custo padrão de recurso já absorvido não determina o método de avaliação `bis_Standard` do item.

Preservar ClosingId, versões imutáveis, PostingHash, RequestHash, claims permanentes, estados de execução, integridade e documentos SAP reconciliados. Não reescrever histórico com algoritmo novo nem apagar claim para reenviar. Timeout ou busca incompleta/ambígua mantém a incerteza; HTTP 201 e soma interna correta não comprovam reconciliação econômica.

As provas técnicas pontuais não homologam o fechamento GGF para produção. Ver [FACTORYONE-CURRENT-STATE.md](docs/FACTORYONE-CURRENT-STATE.md) para separar implementação, história, proposta e pendências. A especificação histórica em CLAUDE contém alternativas e premissas; não ativar `EQUAL`, conta de variação, resíduo ignorado ou regra FIFO/CPV por constarem nela. A prioridade funcional vigente dos quatro critérios e bloqueios está registrada no README e no contrato de rateio.

## Ambiente, segurança e autorização

Consulte [ENVIRONMENTS-AND-AUTHORIZATIONS.md](docs/ENVIRONMENTS-AND-AUTHORIZATIONS.md) antes de comandos com efeitos. `localhost`, nome de base de demonstração ou `FBO_ENV=dev/test` não provam que o destino seja descartável nem concedem permissão financeira.

Preserve a regra existente para ferramentas por credenciais: escrita Service Layer somente sob `FBO_ENV=dev/test` e escopo explicitamente autorizado. A sessão SSO do Web Client tem tratamento distinto documentado em CLAUDE; essa distinção não libera hoje o fechamento GGF nem permite contornar controles. Não desativar TLS, autenticação ou autorização para obter resultado. Exceções históricas locais de certificado não são autorizações atuais.

Não ler ou expor credenciais fora de tarefa explicitamente autorizada para isso. Nunca publicar senhas, cookies, tokens, sessões, cabeçalhos de autorização ou chaves privadas. Evidências devem ser sanitizadas e manter proveniência. Não carregar `.env` por conveniência.

Classifique os efeitos do comando pelo código e dependências antes de executar. Scripts de diagnóstico, `plan`, `verify`, recuperação ou reconciliação podem criar arquivos, sessões, UDOs ou atualizar estados. Mesmo uma ação HTTP POST pode ser leitura SAP específica; método HTTP e nome do script isolados não estabelecem segurança. Na adoção documental nenhuma chamada SAP é permitida, inclusive leituras e login/logout.

## Processo e verificação

1. Registre branch, HEAD, modificados, staged e não versionados. Preserve integralmente trabalho local, evidências e planos incompletos; não limpar, restaurar ou trocar branch por rotina.
2. Defina critérios de aceite, arquivos e validações antes de editar. Use a [matriz contextual de skills](docs/AGENT-SKILLS-WORKFLOW.md), confirme disponibilidade, anuncie a seleção e leia cada SKILL.md escolhido. Não copiar o plugin nem instalar ferramentas sem autorização.
3. Implemente somente o escopo autorizado. Para comportamento, preserve testes e faça verificações significativas pelo procedimento existente. Para documentação, revise conteúdo, links, arquivos novos e diff, sem iniciar automaticamente aplicação ou suíte.
4. Não reduzir assertions, suprimir tipos/lint, adicionar skips, apagar testes ou enfraquecer constraints para passar. Novos requisitos numéricos exigem fundamento, medição e decisão; defaults das skills não são metas do FactoryOne.
5. Revise o resultado completo e compare com o estado inicial. Relate arquivos criados/alterados, verificações executadas, resultados históricos, limitações e pendências. Não declarar checks não executados aprovados.
6. Commit, push, deploy, acesso remoto, metadados, estoque, contabilização, recuperação e avanço de fase exigem autorização compatível. Termine no marco pedido pelo usuário.

Os comandos existentes de teste, typecheck, navegador e build estão no README e em `package.json`; confira o comando atual e seus efeitos antes de usá-lo. Há divergências históricas de empacotamento registradas no mapa de estado. Esta adoção não autoriza executá-los ou corrigi-los.
