# Entrega de leitura SAP - 28/09/2026

## Atualizacao: troca de empresa

Empresa ativa alterada para **SBODEMOBR2** por solicitacao do usuario. Conexao
e leitura de setembro/2026 confirmadas; ver [resultado atual](GGF-READ-MAPPING.md).
O `.env` ignorado foi atualizado sem alterar/expor usuario ou senha. Evidencias
anteriores foram arquivadas separadamente em `.local/ggf/history/`.

Nesta troca: ajustados transporte/runtime, identificacao da tela, periodo inicial,
testes de isolamento entre empresas, README e registro de mapeamento. As regras
de calculo e o bloqueio contabil nao foram alterados. Na troca, 258 testes
unitarios e cinco cenarios de navegador passaram, incluindo rejeicao de
relatorio da empresa anterior. O restante deste documento
descreve a entrega anterior, nao resultados da nova empresa.

## Resultado

Conectividade, TLS estrito, autenticacao e fontes de leitura conferidos na
SBO_DEMO_ECOMMERCE. Os dados nao permitem validar um fechamento industrial:
nenhuma OP/recurso/apontamento, recebimentos sem OP e regras de custo ainda abertas.
Veja [fontes, campos, controles, resultados e reproducao](GGF-READ-MAPPING.md).

A integracao entregue e **conferencia real de fontes**, nao normalizacao completa
para rateio. O coletor MappedGgfSource e reutilizado, sem liberar snapshot parcial
para o motor. Nenhuma gravacao de negocio, SQLQuery, metadado ou contabilizacao
foi realizada no SAP. Login/Logout sao as unicas requisicoes POST.

## Arquivos desta etapa

Configuracao e documentacao:

- `.gitignore`: acrescentado `.local/`, preservando alteracoes anteriores.
- `package.json`, `package-lock.json`: comandos locais e dependencia direta de
  esbuild na mesma versao ja instalada, apenas para empacotar o coletor Node.
- `README.md`, `docs/GGF-READ-MAPPING.md`, `docs/GGF-SOURCE-CONTRACT.md`.
- `docs/GGF-SAP-READ-VERIFICATION.md` (este registro).

Ferramentas locais novas, nao incluidas na extensao:

- `scripts/ggf-sap-session.mjs`: HTTPS estrito, empresa restrita, GET, sessao efemera.
- `scripts/ggf-sap-discover.mjs`: certificado, autenticacao, metadata e catalogo.
- `scripts/ggf-sap-survey.mjs`: contagens globais e amostras projetadas.
- `scripts/ggf-sap-inspect.mjs`: inspecao local de documentos, sem escrita SAP.
- `scripts/ggf-sap-runtime.mjs`: reutilizacao do coletor TypeScript no processo Node.
- `scripts/ggf-sap-read.mjs`: conferencia reproduzivel e relatorio local ignorado.
- `scripts/ggf-sap-preview.mjs`: gateway local 8082 para leitura com opt-in.
- `scripts/ggf-sap-capture.mjs`: verificacao manual real no navegador, sem HAR/traces.

Aplicacao:

- `webapp/core/config/runtime.ts`: opt-in `source=sap-read` somente local/dev.
- `webapp/controller/Home.controller.ts`, `webapp/view/Home.view.xml`.
- `webapp/i18n/i18n.properties`, `webapp/i18n/i18n_en.properties`.
- `webapp/modules/ggf/repository/MappedGgfSource.ts`: coleta diagnostica reutilizavel.
- `webapp/modules/ggf/repository/SapB1ReadMapping.ts`: fontes comprovadas e controles.
- `webapp/modules/ggf/controller/Closing.controller.ts`.
- `webapp/modules/ggf/controller/Menu.controller.ts`.
- `webapp/modules/ggf/view/Closing.view.xml`.
- `webapp/modules/ggf/view/Menu.view.xml`.
- `webapp/modules/ggf/i18n/i18n.properties`.

Testes novos:

- `test/ggf/sapB1ReadMapping.test.ts`.
- `test/ggf/sapSessionBoundary.test.ts`.
- `test/browser/ggf-sap-read.spec.mjs`.

Motor de rateio, quatro criterios, fixtures, CSV, memoria, confirmacao bloqueada
e instalador nao foram alterados nesta etapa. Mudancas preexistentes nessas areas
continuam no workspace. Empacotamento/entrada Web Client foram preservados.

## Verificacoes

- Vitest: **257 testes aprovados**, incluindo mapeamento e transporte offline.
- TypeScript: `npm run typecheck` aprovado.
- UI5: `npm run build:module` aprovado; pacote nao instalado no SAP.
- Navegador: 14 cenarios existentes aprovados na execucao ampla e **4 novos
  aprovados na reexecucao dirigida**, apos corrigir expectativas dos seletores
  de tiles UI5 nos testes. Cobrem desktop/mobile, isolamento de fixtures,
  erro de gateway e revisoes concorrentes.
- Leitura real no navegador: desktop 1440x1000 e mobile 390x844, sem erros de
  JavaScript nem overflow horizontal; avancar bloqueado, valores reais rotulados.
- Gateway: sem opt-in 403; POST 405; origem externa 403; proxy SAP arbitrario 404;
  periodo malformado 400. Nenhum desses testes negativos acessa negocio no SAP.
- `.env` e `.local/ggf/read-report.json` confirmados ignorados pelo Git.
- `git diff --check` aprovado para arquivos da etapa, excluindo whitespace
  preexistente em `.gitignore`.

O npm informou 12 alertas na arvore de dependencias (6 moderados, 5 altos,
1 critico). Nao foi feita atualizacao ampla ou `audit fix --force` fora do escopo.
A ferramenta esbuild e usada para bundle, nao como servidor HTTP.

Capturas historicas reais, locais/ignoradas e sem credenciais: preservadas na
pasta `.local/ggf/history/SBO_DEMO_ECOMMERCE-*/`. Capturas na raiz `.local/ggf/`
pertencem a empresa ativa, nao a esta entrega historica.

Sessao do host, CSP/origem, permissao de leitura e enquadramento dentro do Web
Client nao foram validados por esta previa local. O gateway Node nao e parte
da extensao instalada e nao deve ser exposto na rede.
