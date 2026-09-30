# Cadastros GGF: referencias visuais

Previa: <http://localhost:8081/index.html?mode=development#/ggf>.

As imagens enviadas foram usadas para organizar Classificacao e Rateios em
lista pesquisavel e detalhes do registro, sem reproduzir a aparencia antiga.
Componentes SAPUI5 e tema Horizon preservados. Nenhum acesso ao SAP.

## O Que Mudou

- Classificacao: lista de codigo/descricao, busca, selecao, inclusao, edicao e
  exclusao no formulario de detalhes.
- Rateios: lista de contas com descricao, criterio e sinalizacao de inativas;
  detalhes com conta, descricao, classificacao, criterio e estado ativo.
- A busca em Rateios aceita codigo da conta, descricao ou codigo da classificacao.
- Desktop: lista e formulario lado a lado. Mobile: lista e detalhes alternados,
  com retorno proprio para a lista; a seta superior continua voltando ao menu GGF.
- Estados sem resultado e sem selecao explicitos. Adicionar limpa a busca e abre
  o novo registro. Excluir atualiza a selecao sem deslocar a edicao para outro item.
- Os percentuais permanecem em tabela global, identificada como **todas as contas**.
  Isso evita ocultar percentuais invalidos ou orfaos ao trocar/excluir uma conta.
- Rascunho compartilhado, aviso de alteracoes nao salvas e salvamento local da
  configuracao inteira continuam iguais. Busca e selecao nao mudam o calculo.

## Limites Das Referencias

As imagens nao constituem contrato de integracao SAP. O modelo atual de
Classificacao contem codigo e descricao; a ligacao entre conta e classificacao
continua em Rateios. Nao foi inferida uma conta redutora/contrapartida a partir da
primeira imagem. Essa regra precisara ser definida antes de alterar o contrato.

O assistente existente ja contem os quatro criterios, as tres etapas, os valores
por criterio, total, custos por ordem, memoria e CSV. Nao recebeu alteracoes de
calculo nesta revisao. Graficos de composicao nao foram copiados: valores negativos
sao validos no motor e nao devem ser convertidos em fatias positivas de um grafico.

Custo Indireto, lancamentos contabeis, distribuicao por deposito e Relatorios das
referencias continuam pendentes. Nao foram inventados saldos de estoque, debitos,
creditos, datas/status de OP ou resultados contabilizados. Os tiles Custo Indireto
e Relatorios permanecem **Em desenvolvimento**. Confirmacao bloqueada na tela e
no servico; unidade, origem, completude e regras SAP continuam a validar.

## Capturas

Dados ficticios identificados em todas as telas. Desktop 1440 x 1000;
mobile 390 x 844. Ha rolagem interna SAPUI5, inclusive na tabela de percentuais.
As capturas de teste mostram a selecao e a alteracao de registros locais.

| Tela | Antes | Depois |
| --- | --- | --- |
| Classificacao desktop | [Antes](before-classifications-desktop.png) | [Depois](classifications-list-desktop.png) |
| Classificacao mobile | [Antes](before-classifications-mobile.png) | [Lista](classifications-list-mobile.png), [detalhes](classifications-detail-mobile.png) |
| Rateios desktop | [Antes](before-allocations-desktop.png) | [Depois](allocations-list-desktop.png), [busca e selecao](allocations-detail-desktop.png) |
| Rateios mobile | [Antes](before-allocations-mobile.png) | [Lista](allocations-list-mobile.png), [detalhes](allocations-detail-mobile.png) |

Rateios em [Horizon escuro](allocations-dark.png) e [alto contraste](allocations-contrast.png).

## Arquivos Alterados

```text
webapp/modules/ggf/controller/Closing.controller.ts
webapp/modules/ggf/view/Classifications.fragment.xml
webapp/modules/ggf/view/Allocations.fragment.xml
webapp/modules/ggf/css/closing.css
webapp/modules/ggf/i18n/i18n.properties
test/browser/navigation.spec.mjs
test/browser/ggf-records.spec.mjs
test/browser/ggf-layout.spec.mjs
README.md
docs/navigation/README.md
docs/navigation/classifications-*.png
docs/navigation/allocations-*.png
docs/ggf-reference-ui/README.md
docs/ggf-reference-ui/*.png
```

Motor, contratos, repositorios, etapas/calculos do assistente, configuracao de
empacotamento e rotas nao foram alterados nesta revisao. Alteracoes locais
anteriores preservadas.

## Verificar

```sh
npm test
npm run typecheck
npm run test:browser
npm run build
```

O teste `ggf-records.spec.mjs` verifica busca sem resultados, selecao correta apos
filtrar, edicao sem alterar o registro vizinho, persistencia, inclusao/exclusao,
os quatro criterios e preservacao dos percentuais, em desktop e mobile.
Os testes anteriores continuam cobrindo assistente, navegacao em tres niveis,
concorrencia, exportacao, validacoes e bloqueio de contabilizacao.

Vitest: 225 testes aprovados. TypeScript aprovado. Build `.mtar` concluido e
integridade de ZIP/MTAR conferida. O Make emitiu o aviso de diferenca de relogio
do ambiente WSL. O descritor continua com uma unica entrada FactoryOne.

Playwright: **14 testes aprovados** na suite completa final em 27/09/2026.
Inclui desktop/mobile, ate 320px, densidades compacta/cozy, Horizon claro/escuro
e alto contraste. Capturas inspecionadas no navegador local, nao no SAP.

Durante a verificacao a 320px/cozy, o titulo longo dos percentuais ultrapassava
a largura junto do botao de inclusao. Foi reduzido para **Grupos: todas as contas**.
As verificacoes de geometria aguardam a estabilizacao do layout apos redimensionar.

Conferencia no host real permanece pendente: versao UI5, tema/densidade herdados,
area disponivel, foco/teclado/leitor de tela, rolagem e navegacao dentro do Web Client.
