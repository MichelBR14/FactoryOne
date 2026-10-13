# FactoryOne

Projeto novo em UI5/TypeScript para SAP Business One. O nome interno existente
continua `FactoreOne` (`factoreone.app`); os IDs de empacotamento foram preservados.

## Executar localmente

Requisitos: Node 24 e npm. Nao carregue `.env` para executar o exemplo local.

```sh
npm install
npm start
```

Abra <http://localhost:8080/index.html?mode=development>.
Se a porta estiver ocupada, use `npm start -- --port 8081` e altere a URL.
O servidor serve o OpenUI5 1.120.50 localmente; a primeira execucao baixa as
bibliotecas publicas do framework. Nao existe proxy nem chamada ao SAP neste fluxo.

O modo de desenvolvimento requer `mode=development` e hostname `localhost`,
`127.0.0.1` ou `[::1]`. Sem essa combinacao, o GGF apresenta indisponibilidade,
sem carregar os dados ficticios. A flag nao habilita uma licenca de producao.

## Testar o assistente

### Leitura real SAP em desenvolvimento

Base ativa autorizada: `SBODEMOBR2`, autenticacao e TLS conferidos em 28/09/2026.
Ha 79 OPs e 8 recursos; setembro/2026 possui 67 lancamentos e tres recebimentos
com referencia a OP. O certificado observado vence em 30/09/2026. O modo SAP
permite conferir fontes, **nao calcular um fechamento validado**.
Veja [mapeamento comprovado, resultados e reproducao](docs/GGF-READ-MAPPING.md).

Com UI5 em 8081, execute `npm run ggf:sap:preview` e abra
<http://localhost:8082/index.html?mode=development&source=sap-read#/ggf/fechamento>.
As credenciais ficam no `.env` ignorado, somente no processo Node local.
`npm run ggf:sap:read -- 2026-09-01 2026-09-30` repete a conferencia pelo terminal.
Contabilizacao bloqueada; nenhum fallback para dados ficticios.

Para conferir as bases das OPs referenciadas pelos recebimentos de setembro:
`npm run ggf:sap:orders -- 2026-09-01 2026-09-30`.
Veja [valores por OP, vinculos, horas ausentes e limites de custo](docs/GGF-ORDER-BASIS-AUDIT.md).

Diagnostico funcional complementar, sem refazer a auditoria aprovada:
`npm run ggf:sap:functional`. Veja [composicao, contas, bases reais e riscos de dupla
absorcao](docs/GGF-FUNCTIONAL-DIAGNOSTIC.md). Nao escolhe pool/base nem executa rateio.

Motor ampliado: [criterios, percentuais, memoria e bloqueios](docs/GGF-RATEIO-ENGINE.md).
Na simulacao, configure o percentual total em Rateios e expanda a memoria na
etapa3. Calculo SAP somente leitura com selecao explicita local:
`npm run ggf:sap:calculate -- .local/ggf/calculation-request.json`.
Nenhuma conta e selecionada automaticamente; contabilizacao permanece bloqueada.

Primeira validacao real: [duas apuracoes, memoria e conferencia independente](docs/GGF-REAL-RATEIO-VALIDATION.md).
Custo direto nas OPs76/77/79 e quantidade nas OPs77/79 passaram matematicamente,
usando conta financeira explicitamente marcada como **validacao tecnica, nao GGF**.
`npm run ggf:sap:validate -- .local/ggf/real-validation-request.json` repete as
leituras; `--replay` reproduz uma captura sem conectar ao SAP. Requer Python3
para a conferencia independente. Isso nao aprova pool, contabilizacao ou estoque.

### Demonstracao ficticia separada

A navegacao tem tres niveis: entrada FactoryOne no Web Client, menu de modulos
FactoryOne e menu GGF. Na previa local, entre em **GGF** e escolha uma funcao.
Veja [rotas, capturas atuais e limites no Web Client](docs/navigation/README.md).
Classificacao e Rateios agora usam listas pesquisaveis e formularios de detalhes,
inspirados nas referencias enviadas. Veja [antes/depois dos cadastros](docs/ggf-reference-ui/README.md).
O [registro visual anterior](docs/ggf-ui/README.md) conserva as capturas antes/depois
da substituicao das abas pelo Wizard nativo do SAPUI5.

1. Em **Classificacao**, confira as classificacoes. Volte ao menu GGF e abra
   **Rateios** para contas, criterios e percentuais dos grupos.
   Busque por codigo ou descricao e selecione o registro. No celular, o botao de
   retorno do formulario volta a lista; a seta do cabecalho continua voltando ao
   menu GGF. A tabela de percentuais continua abrangendo todas as contas.
   **Salvar localmente** grava somente no localStorage deste navegador,
   na chave `factoreone.development.ggf.config.v1`. **Restaurar exemplo** altera o
   formulario da funcao aberta; e necessario salvar para substituir a configuracao
   persistida. O rascunho e compartilhado entre as funcoes, com aviso de alteracoes
   nao salvas. A validacao e o salvamento continuam considerando a configuracao inteira.
2. Volte ao menu GGF e abra **Assistente de fechamento / Periodo de apuracao**.
   Mantenha 01/09/2026 a 30/09/2026,
   filial DEV-01 e todos os centros. Clique em **Apurar e calcular**. Resultado:
   custo direto 1000.00, quantidade 600.00, horas 900.00, grupos 1500.00 (BRL).
3. Avance para **Custos por Ordem**: tres ordens, bases do periodo e horas por
   grupo. A exportacao CSV inclui bases, resultados, origem, filtros, referencias
   ficticias e memoria de calculo.
4. Avance para **Distribuicao dos novos custos**: total 4000.00, distribuido
   4000.00, diferenca 0.00. Expanda a memoria de calculo. Custo resultante e o
   custo atual **total da ordem** mais o GGF, nao custo unitario nem reavaliacao.
5. Altere 60% para 50% em **Rateios**, na tabela de grupos: a soma 90% produz erro visivel
   e impede avancar. Restaure 60%. Teste outubro de 2026: ausencia de base produz
   erro, sem distribuicao presumida. Filial DEV-02/centro APOIO tem uma ordem e
   400.00 de GGF. Novas contas sem saldo no exemplo geram erro explicito.

Qualquer edicao de filtro/configuracao invalida os resultados anteriores. O
estado de apuracao e limpo de uma vez, incluindo totais e identificador. Somente
a revisao ativa pode publicar resultado, erro ou finalizar o carregamento;
leituras antigas, inclusive rejeitadas, sao descartadas. O fechamento e sua
memoria ficam em sessao enquanto o assistente esta aberto; sair invalida a consulta
e cada nova entrada comeca na etapa 1, sem resultados anteriores. Somente a
configuracao e persistida.
O botao de contabilizacao e o metodo de confirmacao do servico estao bloqueados.

## Verificacoes

A suite inclui a conferencia independente de rateio e requer Python3, alem do Node24.

```sh
npm test
npm run typecheck
npx playwright install chromium
npm run test:browser
npm run build:module
npm run compress
```

`test:browser` abre/usa a porta 8081, testa desktop/mobile e bloqueia requisicoes
externas no navegador. Screenshots e CSV ficam em `factoryone-browser-results`
dentro do diretorio temporario do sistema. O `.mtar` completo usa `npm run build`
e requer Cloud MTA Build Tool (`mbt`) e GNU Make instalados para o mesmo sistema
operacional do Node.

Nao compartilhe a mesma instalacao de `node_modules` entre Windows e WSL sem
reinstalar os binarios opcionais para o sistema em uso. Nesta analise, o terminal
WSL tinha Node 18 e faltava o Rollup Linux; os checks foram executados com Node 24.
O Chromium no WSL tambem precisava de bibliotecas nativas. Nesta sessao, Node/MBT
e essas bibliotecas foram instalados em pastas temporarias, sem alterar o Node
do sistema. Para repetir os testes de navegador neste mesmo terminal:

```sh
env PATH="/tmp/factoryone-tools/node_modules/node/bin:$PATH" \
  LD_LIBRARY_PATH=/tmp/factoryone-browser-libs/extracted/usr/lib/x86_64-linux-gnu \
  npm run test:browser
```

Em um novo ambiente Linux, `npx playwright install --with-deps chromium` instala
o navegador e suas dependencias nativas (estas exigem permissao de sistema).

## Arquitetura E Limites

- `webapp/modules/ggf/engine`: motor puro, valores monetarios bigint em centavos,
  quantidades/horas ate seis casas e percentuais ate duas. Arredondamento pelo
  maior resto fracionario, desempate pelo ID da ordem/grupo. Valores negativos
  conservam o sinal. Grupos recebem sua parcela em centavos antes do rateio por
  horas; cada nivel concilia integralmente.
- `repository/GgfRepository.ts`: contrato normalizado de configuracao, catalogos
  e snapshot. Nao define endpoints ou entidades SAP. A origem, filtros, momento
  de captura e referencias dos dados acompanham cada calculo.
  O [contrato de bases normalizadas](docs/GGF-SOURCE-CONTRACT.md) detalha unidades,
  definicoes comparaveis, regras de conversao e evidencia de completude exigidas
  pelo motor. As evidencias ficticias acompanham o CSV de desenvolvimento.
- `repository/GgfSource.ts` e `MappedGgfSource.ts`: fronteira somente de leitura
  e coletor paginado com mapeamento injetado. `SapB1ReadMapping.ts` usa as fontes
  reais comprovadas para conferencia; nao normaliza um snapshot de rateio.
  Veja o [levantamento real e seus bloqueios](docs/GGF-READ-MAPPING.md).
- `development`: dados ficticios e repositorio local, separados do cliente
  Service Layer. Saldos excluem os movimentos ficticios marcados como gerados
  pelo proprio GGF. Filtros se aplicam tanto a movimentos quanto a saldos.
- `service`: ciclo de calculo, invalidacao inclusive de leituras assincronas,
  bloqueio de confirmacao e exportacao CSV com protecao contra formulas.
- `controller`, `view`, `i18n`: interface UI5 integrada ao roteamento do app.

O adaptador SAP futuro devera assegurar completude/paginacao, moeda/precisao,
quantidades em unidades comparaveis, periodo/filtros, elegibilidade das OPs,
custos atuais e exclusao de movimentos proprios. Nao converter dado ausente em
zero: saldo zero so e valido quando comprovado pela origem completa. A soma das
horas por grupo deve conciliar com as horas totais. Saldo negativo e aceito;
bases negativas ou ausentes sao rejeitadas. Grupos com percentual positivo
precisam de horas, mesmo se a parcela monetaria arredondar para zero.

## Diagnostico Do Repositorio Recebido

Base analisada: `fbfd48d`, com seis commits desde o nucleo inicial ate logs.
A alteracao local preexistente de `.gitignore` foi preservada. Nenhum projeto
antigo ou conteudo de `referencia/` foi usado.

**Implementado antes desta entrega:** aritmetica monetaria, flags de licenca,
configuracao de integracao, cliente HTTP com renovacao de sessao e batch,
planejador/instalador de metadados e repositorios de setup/log. A tela unica
listava modulos usando flags fixas; nao chamava o instalador nem carregava licencas.

**Simulado ou pendente:** testes HTTP/metadados usam fakes; SSO e apenas uma
interface, sem provedor concreto do Web Client. Nao havia modulo GGF, telas do
instalador, autorizacoes, SQLQueries, persistencia de regras/apuracoes ou entrada
HTML para execucao local. A documentacao descrevia varias dessas pecas como
planejamento. O `.mtar` existente nao prova funcionamento no Web Client.

**Correcoes do nucleo:** o instalador agora rejeita leituras incompletas (inclusive
limite de 100 paginas com proxima pagina pendente) e divergencias de metadados
antes de qualquer criacao ou gravacao de versao. `plan()` continua permitindo
examinar divergencias sem escrever; `install()` lanca erro bloqueante com o plano.
Os testes cobrem ausencia de escritas e preservacao da versao nesses casos.
A instalacao npm tambem reportou vulnerabilidades em dependencias
de desenvolvimento; atualizacoes de ferramenta nao foram misturadas ao GGF.

## Quando O SAP Voltar

Continuam pendentes: validar SSO, licencas e autorizacoes; contrato de dados e
consultas reais; metadados/persistencia de configuracoes e apuracoes; logs reais;
importacao do pacote e navegacao no Web Client. Validar a regra contabil de
estoque/CPV, metodos de custo, moeda, periodos, idempotencia e estorno antes de
criar qualquer caminho de escrita de fechamento. O coletor de leitura esta
preparado e testado com respostas simuladas, mas o mapeamento especifico SAP nao
esta implementado, habilitado ou validado.

Para o escopo atual, a referencia funcional do usuario prevalece sobre o
planejamento historico do `CLAUDE.md`: quatro criterios e erro bloqueante para
bases inexistentes/percentuais invalidos. Nao ha fallback para rateio igual,
residuo ignorado ou conta de variacao.

## Arquivos Da Entrega

Alterados:

```text
package.json
package-lock.json
ui5.yaml
webapp/manifest.json
webapp/controller/Home.controller.ts
webapp/view/Home.view.xml
webapp/i18n/i18n.properties
webapp/i18n/i18n_en.properties
webapp/core/data/MetadataInstaller.ts
webapp/core/data/plan.ts
test/core/data/installer.test.ts
```

Criados:

```text
README.md
docs/GGF-SOURCE-CONTRACT.md
docs/GGF-READ-MAPPING.md
playwright.config.mjs
test/browser/ggf.spec.mjs
test/ggf/allocation.test.ts
test/ggf/workflow.test.ts
test/ggf/sourceEvidence.test.ts
test/ggf/mappedSource.test.ts
webapp/index.html
webapp/core/config/runtime.ts
webapp/modules/ggf/controller/Closing.controller.ts
webapp/modules/ggf/development/DevelopmentGgfRepository.ts
webapp/modules/ggf/development/fixtures.ts
webapp/modules/ggf/engine/allocation.ts
webapp/modules/ggf/engine/types.ts
webapp/modules/ggf/engine/errors.ts
webapp/modules/ggf/engine/sourceEvidence.ts
webapp/modules/ggf/i18n/i18n.properties
webapp/modules/ggf/repository/GgfRepository.ts
webapp/modules/ggf/repository/GgfSource.ts
webapp/modules/ggf/repository/MappedGgfSource.ts
webapp/modules/ggf/service/ClosingSession.ts
webapp/modules/ggf/service/export.ts
webapp/modules/ggf/view/Closing.view.xml
```

Artefatos regenerados (ja ignorados pelo Git): `factoreone.module/`,
`resources/factoreoneapp.zip`, `mta_archives/ext-factoreone_0.1.0.mtar`.
O `.gitignore` permanece com a alteracao local recebida, sem edicao desta entrega.

## Adocao documental das Agent Skills — 13/10/2026

Foi aprovada a integracao exclusivamente documental das Agent Skills, como
processo complementar ao AGENTS global. As instrucoes e os registros anteriores
deste README e do CLAUDE foram preservados; a decisao nao autoriza operacoes SAP,
mudancas de codigo, novas fases, commit, push ou deploy.

Leia [AGENTS.md](AGENTS.md) e [CONSTRAINTS.md](CONSTRAINTS.md) antes de trabalhar.
O [indice documental](docs/README.md) organiza os contratos existentes, a
[matriz contextual das skills](docs/AGENT-SKILLS-WORKFLOW.md), o
[plano e validacao da integracao](docs/AGENT-SKILLS-INTEGRATION.md), o
[estado atual e alcance das provas](docs/FACTORYONE-CURRENT-STATE.md) e os
[ambientes e autorizacoes](docs/ENVIRONMENTS-AND-AUTHORIZATIONS.md).
Os comandos e resultados anteriores devem ser interpretados no escopo de suas
etapas; confira o script atual e seus efeitos antes de uma execucao autorizada.
Provas tecnicas historicas nao liberam novas operacoes financeiras nem declaram
o fechamento GGF homologado para producao.
