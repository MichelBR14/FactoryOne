# GGF: revisao visual local

Registro historico da primeira revisao visual. A navegacao pelo cabecalho descrita
abaixo foi substituida por [menus e rotas em tres niveis](../navigation/README.md).
As capturas foram mantidas como evidencia do antes/depois daquela revisao.

Previa atual: <http://localhost:8081/index.html?mode=development#/ggf/fechamento>.
Todas as capturas usam dados ficticios, sem conexao ao SAP.

## Alteracoes

- Duas barras de abas substituidas por `sap.m.Wizard`, em modo de uma etapa
  por pagina, com sequencia numerada e indicador explicito de etapa atual.
- Configuracao separada do assistente, pelo cabecalho. Voltar ao fechamento
  preserva a etapa visitada; editar regras ou filtros invalida o resultado.
- Filtros agrupados por competencia e abrangencia; quatro valores por criterio
  em uma faixa de resumo. Conciliacao em destaque na distribuicao.
- Identificacao da ordem/produto reunida, valores alinhados e linhas alternadas.
  Colunas secundarias viram detalhes por linha em telas pequenas, sem omitir bases.
- Acoes de avancar/voltar e salvar no rodape; exportacao junto das tabelas;
  memoria de calculo continua expansivel. Confirmacao permanece desabilitada.
- CSS restrito a `.ggfPage`, com tamanhos em rem, grids responsivos e variaveis
  do tema. Nao define paleta propria nem altera globalmente tema ou densidade.

## Antes E Depois

Desktop: 1440 x 1000. Mobile: 390 x 844. Pares com a mesma densidade compacta da
previa local. As capturas mostram a area visivel, com rolagem interna da pagina.

| Etapa | Desktop antes | Desktop depois | Mobile antes | Mobile depois |
| --- | --- | --- | --- | --- |
| Periodo apurado | [Antes](before-period-desktop.png) | [Depois](after-period-desktop.png) | [Antes](before-period-mobile.png) | [Depois](after-period-mobile.png) |
| Custos por Ordem | [Antes](before-orders-desktop.png) | [Depois](after-orders-desktop.png) | [Antes](before-orders-mobile.png) | [Depois](after-orders-mobile.png) |
| Distribuicao | [Antes](before-distribution-desktop.png) | [Depois](after-distribution-desktop.png) | [Antes](before-distribution-mobile.png) | [Depois](after-distribution-mobile.png) |
| Configuracao | [Antes](before-configuration-desktop.png) | [Depois](after-configuration-desktop.png) | [Antes](before-configuration-mobile.png) | [Depois](after-configuration-mobile.png) |

Variantes adicionais: [Horizon escuro](after-distribution-dark.png),
[configuracao escura](after-configuration-dark.png),
[alto contraste](after-distribution-contrast.png) e
[mobile com densidade cozy](after-distribution-mobile-cozy.png).

## Verificacao Reproduzivel

```sh
npm test
npm run typecheck
npm run test:browser
npm run build
```

Os testes de navegador bloqueiam requisicoes externas e caminhos `/b1s/`.
`ggf.spec.mjs` cobre concorrencia, limpeza de resultados, validacoes, persistencia,
CSV, mobile e indisponibilidade sem modo de desenvolvimento.
`ggf-layout.spec.mjs` cobre as tres etapas, memoria, retorno da configuracao,
edicao invalidante, navegacao por teclado, limites horizontais, rodape visivel,
Horizon claro/escuro/alto contraste e densidades compacta/cozy ate 320px.
Capturas novas sao geradas no diretorio temporario `factoryone-browser-results`.

Resultado local em 27/09/2026: 222 testes Vitest, 8 testes Playwright e TypeScript
aprovados. Os 5 cenarios visuais foram repetidos e aprovados apos o ultimo ajuste
mobile. Build `.mtar` concluido; integridade dos arquivos compactados e inclusao
da view/CSS conferidas. O Make emitiu aviso de diferenca de relogio no WSL.

## Arquivos Desta Revisao

```text
webapp/modules/ggf/view/Closing.view.xml
webapp/modules/ggf/controller/Closing.controller.ts
webapp/modules/ggf/css/closing.css
webapp/modules/ggf/i18n/i18n.properties
webapp/manifest.json
test/browser/ggf.spec.mjs
test/browser/ggf-layout.spec.mjs
README.md
docs/ggf-ui/README.md
docs/ggf-ui/*.png
```

Motor, repositorios, contrato de origem, memoria de calculo e geracao de CSV
nao foram alterados nesta revisao. Artefatos de build sao regenerados nas pastas
ja ignoradas pelo Git. Alteracoes locais preexistentes foram preservadas.

## Conferencia No Web Client

A previa usa OpenUI5 1.120.50 e Horizon. Nao representa uma validacao visual da
extensao instalada nem uma reproducao da versao exata do Web Client atual.
Quando o SAP voltar, conferir:

- Composicao com shell, navegacao e cabecalho do host; ausencia de duplicacao
  visual e comportamento do retorno aos modulos.
- Versao SAPUI5 efetiva, tema herdado, branding, densidade e parametros do tenant.
- Altura disponivel da extensao, barras fixas e rolagem dentro do container real.
- Foco, teclado, zoom, leitor de tela e contraste no contexto integrado.
- Nomes, valores e volumes reais nas tabelas, inclusive textos longos e traducoes.

As verificacoes locais nao equivalem a uma auditoria completa de acessibilidade.
Integracao de dados e regra contabil continuam pendentes; contabilizacao bloqueada.
