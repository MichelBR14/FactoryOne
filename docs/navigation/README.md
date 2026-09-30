# Navegacao FactoryOne

Previa local: <http://localhost:8081/index.html?mode=development>.
Nenhuma conexao SAP foi realizada. Os dados do GGF continuam ficticios e
identificados como modo de desenvolvimento. Contabilizacao bloqueada na tela e
no servico. Motor, contratos de origem, repositorios, memoria e CSV nao mudaram.

## Hierarquia E Rotas

1. Web Client SAP B1: uma entrada **FactoryOne**, definida pelo descritor gerado.
2. FactoryOne (`#/` ou sem hash): tiles GGF, Industrializacao/Producao e Qualidade.
3. GGF (`#/ggf`): Classificacao, Rateios, Assistente de fechamento, Custo Indireto
   e Relatorios.

| Funcao | Rota | Conteudo |
| --- | --- | --- |
| Classificacao | `#/ggf/classificacao` | Cadastro de classificacoes |
| Rateios | `#/ggf/rateios` | Contas participantes, quatro criterios e percentuais por grupo |
| Assistente de fechamento | `#/ggf/fechamento` | Periodo, custos por ordem e distribuicao |

Cada funcao retorna ao menu GGF; este retorna ao FactoryOne. Links diretos e
historico do navegador sao cobertos pelos testes. Nao existem abas para esses niveis.
Classificacao e Rateios usam fragmentos separados na view de funcao compartilhada,
preservando o rascunho enquanto se navega. Alteracoes nao salvas sao sinalizadas.
Salvar valida e persiste a configuracao inteira localmente. Restaurar exemplo
altera apenas classificacoes ou contas/percentuais, conforme a funcao aberta.

O assistente sempre abre na etapa 1. Sair invalida a apuracao e consultas pendentes;
respostas tardias nao podem publicar resultados. Dentro do assistente, a navegacao
entre etapas, memoria, CSV e conciliacao permanecem disponiveis apos calcular.

`core` e infraestrutura, nao um modulo de usuario. `ind` consta do catalogo tecnico,
mas nao tem tela implementada. Qualidade aparece no planejamento do projeto, sem
implementacao. Ambos ficam indisponiveis. Nao foram encontrados servicos ou telas
reais de Custo Indireto ou Relatorios: os dois tiles ficam **Em desenvolvimento**,
sem acao por clique ou teclado. O CSV do assistente nao foi apresentado como modulo
de Relatorios. Fora do modo local de desenvolvimento, as funcoes GGF tambem ficam
indisponiveis: nao existe adaptador SAP validado ligado a elas.

O catalogo visual (`navigation.ts`) nao altera identificadores de licenca nem
promete autorizacao de producao. A hierarquia segue os nomes fornecidos no pedido.
As referencias visuais foram enviadas posteriormente; a revisao de Classificacao
e Rateios esta registrada em [antes/depois dos cadastros](../ggf-reference-ui/README.md).

## Capturas

Desktop 1440 x 1000; mobile 390 x 844. As telas tem rolagem interna SAPUI5.
A primeira camada abaixo e uma **previa tecnica local**, montada com o descritor
real gerado. **Nao e uma captura do Web Client, nem prova de instalacao no SAP.**

| Camada / Funcao | Desktop | Mobile |
| --- | --- | --- |
| 1. Contrato da entrada SAP (previa tecnica) | [Captura](entry-contract-desktop.png) | [Captura](entry-contract-mobile.png) |
| 2. Menu FactoryOne | [Captura](factoryone-desktop.png) | [Captura](factoryone-mobile.png) |
| 3. Menu GGF | [Captura](ggf-menu-desktop.png) | [Captura](ggf-menu-mobile.png) |
| Assistente, etapa 1 | [Captura](assistant-desktop.png) | [Captura](assistant-mobile.png) |
| Classificacao | [Captura](classifications-desktop.png) | [Captura](classifications-mobile.png) |
| Rateios | [Captura](allocations-desktop.png) | [Captura](allocations-mobile.png) |

Menu GGF mobile: [continuacao da rolagem](ggf-menu-mobile-bottom.png).

## Empacotamento E Validacao SAP Pendente

Somente o nome exibido do tile foi ajustado para **FactoryOne**. Foram preservados
`PRODUCT_NAME=FactoreOne`, namespace `factoreone.app`, modulo `factoreone`,
artefato `ext-factoreone`, versao, MTA, view raiz `App`, container `app`, rota inicial
Home, uma unica entrada,
`ExistingWindow`, `1x1`, `enableTitleHeader=false`, subtitulo e icone existentes.
Nao foi inventado URL de entrada no descritor. O script de captura verifica essas
propriedades contra o `WebClientExtension.json` produzido pelo build.

Com o servidor ligado, ainda sera necessario verificar:

- Instalacao/importacao do pacote no Extension Manager e publicacao do tile unico.
- Abertura da entrada no menu FactoryOne e roteamento dentro do container real.
- Tema Horizon herdado, versao SAPUI5, densidade, branding e largura/altura do host.
- Cabecalhos, foco, leitor de tela, teclado, rolagem e retornos sem conflito com o shell.
- Links diretos e historico quando a extensao estiver hospedada no Web Client.
- SSO, autorizacoes e licencas reais, sem usar a flag local como autorizacao.
- Adaptador somente de leitura, unidades, normalizacao, origem e completude das bases.
- Regra contabil e testes integrados antes de qualquer liberacao da confirmacao.

## Reproduzir As Verificacoes

```sh
npm test
npm run typecheck
npm run test:browser
npm run build
node test/browser/capture-entry.mjs
```

O ultimo comando requer a previa na porta 8081 e Chromium instalado, usa apenas
localhost e grava as duas capturas tecnicas em `docs/navigation`. Os testes de
navegador gravam as outras capturas no diretorio temporario
`factoryone-browser-results`; os arquivos desta pasta sao copias dessa execucao.
Configuracao WSL/Node/Chromium: veja o README principal.

Vitest: 225 testes em 19 arquivos aprovados. TypeScript (`tsc --noEmit`) aprovado.
Playwright: 14 testes aprovados na execucao completa final (27/09/2026), incluindo
os tres caminhos FactoryOne -> GGF -> funcao e seus retornos, links diretos,
historico, entrada na etapa 1, invalidacao de consulta pendente, persistencia,
quatro criterios, memoria, CSV, erros e bloqueio de contabilizacao. Verificados
desktop, mobile ate 320px, densidades compacta/cozy e Horizon claro/escuro/alto
contraste, alem de busca e edicao de registros nos novos cadastros. Requisicoes
externas e caminhos SAP foram bloqueados pelos testes;
os cenarios novos de navegacao tambem conferem que nenhuma tentativa ocorreu.
Uma primeira execucao apontou geometria durante a animacao de troca de pagina;
o teste passou a aguardar o fim da transicao, e a suite completa foi repetida.
Build `.mtar` concluido; ZIP e MTAR passaram na verificacao de integridade. O Make
emitiu um aviso de diferenca de relogio no WSL. O conteudo do ZIP inclui os menus,
rotas, CSS e fragmentos novos; isso nao comprova instalacao ou execucao no SAP.

## Arquivos Desta Alteracao

```text
webapp/core/config/product.ts
webapp/core/config/navigation.ts
webapp/controller/Home.controller.ts
webapp/view/Home.view.xml
webapp/css/navigation.css
webapp/i18n/i18n.properties
webapp/i18n/i18n_en.properties
webapp/manifest.json
webapp/modules/ggf/controller/Menu.controller.ts
webapp/modules/ggf/controller/Closing.controller.ts
webapp/modules/ggf/view/Menu.view.xml
webapp/modules/ggf/view/Closing.view.xml
webapp/modules/ggf/view/Classifications.fragment.xml
webapp/modules/ggf/view/Allocations.fragment.xml
webapp/modules/ggf/i18n/i18n.properties
scripts/generate-webclient-extension.mjs
test/app/navigation.test.ts
test/browser/navigation.spec.mjs
test/browser/ggf.spec.mjs
test/browser/ggf-layout.spec.mjs
test/browser/capture-entry.mjs
README.md
docs/ggf-ui/README.md
docs/navigation/README.md
docs/navigation/*.png
```

Artefatos de build regenerados nas pastas ignoradas pelo Git. Alteracoes locais
preexistentes, inclusive `.gitignore` e `webapp.zip`, preservadas.
