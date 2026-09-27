# FactoreOne — suíte industrial para SAP Business One (Web Client Extensions)

> Este arquivo é a especificação e o guia de trabalho para o Claude Code. Leia inteiro antes de começar.
> Tudo marcado com **[CONFIRMAR]** é uma premissa que deve ser validada com o responsável antes de ser implementada de forma definitiva.
> "FactoreOne" é o **nome de trabalho** do produto. O nome comercial pode mudar: nunca espalhe o nome pelo código, use as constantes de `/core/config/product.ts` e as chaves de i18n.

---

## 1. Visão do produto

**FactoreOne** é uma suíte de módulos industriais que roda como extensão do **SAP Business One Web Client**. Ela nasce com um módulo e cresce para cobrir o processo industrial:

| Módulo | Código | Escopo | Status |
|---|---|---|---|
| **Núcleo** | `core` | Service Layer, sessão, i18n, tabelas da plataforma, autorizações, licenciamento, logs | Fase 0 |
| **Custos / GGF** | `ggf` | Rateio dos Gastos Gerais de Fabricação às Ordens de Produção e custo real da OP | Fases 1–4 |
| **Industrialização** | `ind` | Remessa e retorno para industrialização, beneficiamento, saldo em poder de terceiros | Futuro (só especificar quando chegar a vez) |
| (futuros) | — | apontamento, qualidade, etc. | — |

Comunicação: sempre "FactoreOne **para** SAP Business One". Não usar "SAP" no nome do produto.

### 1.1 Regra de ouro da suíte
- Tudo que dois módulos possam precisar mora no **núcleo**.
- Um módulo **nunca** importa código de outro módulo. Se precisar, o código sobe para o núcleo.
- Cada módulo pode ser **licenciado e habilitado separadamente**.

---

## 2. Stack e arquitetura

| Camada | Tecnologia |
|---|---|
| Front-end | SAPUI5 / Fiori (TypeScript), como **extensão do SAP B1 Web Client** |
| Integração com o B1 | **Service Layer** (OData v4) — nunca acesso direto ao banco |
| Leitura de dados agregados | `SQLQueries` do Service Layer (consultas SQL cadastradas) **[CONFIRMAR versão do B1 e se é HANA ou SQL Server]** |
| Persistência própria | UDTs + UDOs criados via Service Layer (`UserTablesMD`, `UserFieldsMD`, `UserObjectsMD`) |
| Regras de negócio | Motores TypeScript **puros** por módulo (sem UI5, sem HTTP), cobertos por testes |
| Empacotamento | `.mtar` (Cloud MTA Build Tool) importado no **SAP Business One Extension Manager** |
| Opcional | Service Layer Extension (script JS) para processamentos pesados no servidor **[CONFIRMAR]** |

### 2.1 Ambiente de desenvolvimento (já configurado)
- Node.js 24 LTS, npm 11, GNU Make 4.4.1, Cloud MTA Build Tool (`mbt`) 1.2.47, VS Code com `vscode-mta-tools`.
- SDK do SAP B1 (FP 2608) instalado em `C:\Program Files (x86)\SAP\SAP Business One SDK\`; o plugin do Web Client para VS Code (wizard) está em `Tools\WebClientVSCodePlugin` (v1.5.0, 2026-08). Ele é usado só como **referência de formato**, não para gerar o projeto (ver 2.2).
- Pendente: Web Client Inspector, modo desenvolvedor do Web Client no ambiente de dev.

### 2.2 Scaffold — esqueleto manual, sem wizard
**Decisão (2026-09-26):** o esqueleto é mantido à mão neste repositório, **sem usar o wizard**. O formato é o mesmo que o wizard 1.5.0 do SDK da FP 2608 gera para app Fiori (`generators/general-app/templates/mta-fiori.yaml.template`, `package-fiori.json.template`, `index.js.template`). **Não invente um formato diferente**: se algo do empacotamento mudar, compare com esses templates e com o exemplo oficial de 2021.

Formato do pacote:
- `mta.yaml` com **um único módulo** `type: fiori-app`, `path: .`, `builder: custom`, sem recurso `html5-apps-repo` e sem `deploy_mode`. O ID do MTA (`ext-factoreone`) e o nome do módulo (`factoreone`) derivam do nome do produto.
- O módulo é o app já **buildado** em `<módulo>.module/`, com `manifest.json` (exige `sap.app.id` e `sap.app.applicationVersion`) e `WebClientExtension.json` (tiles) na raiz. O `compress` zipa essa pasta em `resources/<sap.app.id sem pontos>.zip` e o `mbt build` empacota `resources/` no `.mtar`.
- O **primeiro tile de um app Fiori é a página inicial** e não leva `url`. Tiles seguintes usam `url` no formato `&/<rota>`. `linkmethod` só aceita `ExistingWindow` para Fiori.

Como o build funciona aqui (o wizard só empacota um app pronto; o UI5 é buildado por nós):
- `npm run build:module`: `ui5 build` (`@ui5/cli` 4 + `ui5-tooling-transpile`, TypeScript → `sap.ui.define`) para `factoreone.module/`, depois `scripts/generate-webclient-extension.mjs` gera o `WebClientExtension.json`. O nome do tile vem de `product.ts` e o subtítulo do i18n (`tileSubtitle`); nada de nome repetido à mão nesse arquivo.
- `npm run compress`: `scripts/compress.mjs`, equivalente ao `index.js` do wizard, mas **falha com código diferente de zero** em qualquer erro (o do wizard só registra e segue).
- `npm run build`: `mbt build` → `mta_archives/ext-factoreone_<versão>.mtar`. Não passar `--mtar` sem a extensão: o `mbt` 1.2.47 usa o valor exato.
- Classes de UI5 em TypeScript precisam de `@namespace` no JSDoc (ex.: `@namespace factoreone.app.controller`), senão o transpilador nomeia a classe pelo caminho da pasta (`webapp.controller.Main`).
- `mta.yaml`, `manifest.json` e `package.json` repetem nome e versão por serem estáticos; `test/app/packaging.test.ts` confere que continuam de acordo com `product.ts`.

Comparado ao exemplo oficial de 2021 (FP 2105), **fora do formato atual**: módulo `html5` + `com.sap.application.content`, `html5-apps-repo`, `deploy_mode: b1-webclient`, `xs-app.json`, `ui5-task-zipper`, `generateManifestBundle` e `generateCachebusterInfo`. Nenhuma dessas peças é usada; o exemplo antigo serve só para comparação. Material de referência local (fora do git): `referencia/`.

**Não validado:** o `.mtar` gerado ainda não foi importado no Extension Manager nem aberto no Web Client. TODO [CONFIRMAR] `minUI5Version` (hoje 1.120.0), tema, roteamento/`rootView` dentro do Web Client e se o `.mtar` no formato da FP 2608 é aceito como está.

### 2.3 Um app ou vários? [CONFIRMAR]
Duas opções — apresentar prós e contras ao responsável antes de decidir:
- **A) Um app UI5 com vários tiles** (um por módulo), empacotado num único `.mtar`. Mais simples de manter e de licenciar pelo núcleo. *Sugestão padrão.*
- **B) Um `.mtar` por módulo** + biblioteca comum. Permite instalar só o módulo comprado, mas exige versionar e distribuir o núcleo como dependência.

### 2.4 Estrutura de pastas (opção A)
```
/webapp
  /core
    /config          product.ts (nome, prefixo, versão), feature flags
    /service         ServiceLayerClient.ts (login, sessão, $batch, erros), SqlQueryRunner.ts
    /data            MetadataInstaller.ts (lê o que existe, planeja e cria UDT/UDF/UDO), plan.ts, metadata.ts,
                     SetupRepository.ts, BaseRepository.ts, /definitions (metadados de cada módulo, em TS tipado)
    /auth            Authorization.ts (autorizações por função), License.ts (módulos habilitados)
    /ui              componentes/fragmentos reutilizáveis, formatters, MessageHandler
    /util            money.ts (centavos/decimal), dates.ts (períodos), hashing.ts
  /modules
    /ggf
      /view /controller /i18n
      /engine        allocation.ts, rounding.ts, posting-plan.ts, types.ts  (puro)
      /repository    GgfRepository.ts, GgfSourceData.ts
    /ind             (vazio até a fase do módulo)
  /i18n              textos do núcleo (pt_BR padrão, en)
  Component.ts, manifest.json, /view, /controller   tela inicial da suíte (tile único; hoje lista os módulos e o estado da licença)
/scripts             build do módulo Web Client (WebClientExtension.json, compress)
mta.yaml, ui5.yaml   empacotamento (ver 2.2)
/setup
  /core              (metadados da plataforma ficam em webapp/core/data/definitions/core.ts, ver seção 9)
  /ggf               udt-udf-udo.json, sql-queries/*.sql
/test
  /app               consistência do empacotamento com product.ts
  /core
  /ggf/engine        testes do motor + fixtures/*.json
```

---

## 3. Núcleo (`core`)

### 3.1 Convenções da plataforma
- **Prefixo de tabelas:** `FBO_` + código do módulo. Ex.: `FBO_GGF_RULE`. Tabelas do núcleo: `FBO_` direto. (decidido: `FBO_`, ver seção 9) — definir em `product.ts` e **respeitar o limite de tamanho de nome de UDT/campo do B1** (validar no instalador).
- **Referência em documentos gerados:** `Ref3` / `Memo` com prefixo `FO-<MÓDULO>-...` para rastrear o que a suíte lançou.
- Toda criação de metadados é **idempotente**: o instalador compara o que existe com o que está em `/setup` e só cria o que falta. Nunca apaga campos.

### 3.2 Tabelas do núcleo
- `FBO_SETUP` — versão dos metadados instalados por módulo (para migrações).
- `FBO_LIC` — módulos habilitados e dados de licença **[CONFIRMAR modelo de licenciamento; no MVP, só uma flag por módulo]**.
- `FBO_LOG` — log de processamentos: módulo, rotina, usuário, início/fim, status, mensagem, referência do documento.

### 3.3 Serviços do núcleo
- `ServiceLayerClient`: sessão do Web Client (SSO) quando disponível **[CONFIRMAR como a extensão obtém a sessão do Service Layer]**; `$batch` com changesets; tradução de erros do SL em mensagens legíveis.
- `MetadataInstaller`: tela "Instalar/Atualizar FactoreOne" que cria/atualiza UDTs, UDFs, UDOs e SQLQueries de cada módulo habilitado.
- `Authorization`: verifica permissão por função (ex.: `GGF_CONFIG`, `GGF_RUN`, `GGF_POST`) **[CONFIRMAR mecanismo de autorização disponível na versão]**.
- `money.ts`: operações monetárias em inteiros (centavos) ou biblioteca decimal — **proibido** somar valores com float.

---

## 4. Módulo Custos / GGF (`ggf`)

### 4.1 Objetivo
Apurar os **custos indiretos de fabricação** do mês (energia, manutenção, depreciação, mão de obra indireta, aluguel da fábrica etc.) e **ratear entre as Ordens de Produção (OPs)** do período, reavaliando o custo do produto acabado e contabilizando no SAP B1. Resultado: o **custo real** de cada OP (material + recursos + GGF).

Fluxo mensal:
1. Configurar **regras de rateio** (por conta contábil ou faixa de contas).
2. Abrir uma **Apuração** para mês/ano (e filial, se multifilial).
3. Buscar os **saldos** das contas de GGF no período.
4. Buscar as **OPs do período** e as **bases de rateio**.
5. **Simular** → conferência com memória de cálculo.
6. **Contabilizar**: reavaliação de estoque do PA + CPV da parte já vendida/consumida.
7. **Estornar** quando necessário.

### 4.2 Modelo de dados

**`FBO_GGF_CFG`** — configuração (registro único)
- `U_AcctContra` — conta de contrapartida (sugestão: redutora "(-) GGF apropriado à produção")
- `U_AcctCPV` — conta de CPV
- `U_AcctVariance` — conta de diferenças quando não há estoque a reavaliar
- `U_RevalMode` — `STOCK_THEN_CPV` (padrão) | `ALL_CPV` | `ALL_VARIANCE`
- `U_Sequential` — Y/N: exige mês anterior contabilizado
- `U_UseBranch` — Y/N: apuração por filial (BPLId)
- `U_Decimals` — casas decimais (padrão 2)

**`FBO_GGF_RULE`** — regras de rateio (MasterData com linhas)
- Cabeçalho: `Code`, `Name`, `U_Active`, `U_AcctFrom`, `U_AcctTo` (ou linhas de contas), `U_Dim1..U_Dim5`, `U_Basis`, `U_ItmGrp`, `U_ResGrp`, `U_Whs`, `U_BPLId`
- Linhas `FBO_GGF_RULE1`: `U_Key` (item, grupo de item ou grupo de recurso), `U_Pct`, `U_Weight`

**`FBO_GGF_RUN`** — apuração (Document UDO)
- Cabeçalho: `U_Year`, `U_Month`, `U_BPLId`, `U_Status` (`DRAFT` → `SIMULATED` → `POSTING` → `POSTED` → `REVERSED` | `ERROR`), `U_TotalGGF`, `U_TotalAlloc`, `U_Residual`, `U_PostDate`, `U_Remarks`, `U_CreatedBy`, `U_PostedBy`
- `FBO_GGF_RUN1` — saldo por regra/conta: `U_Rule`, `U_Account`, `U_Dims`, `U_Amount`
- `FBO_GGF_RUN2` — resultado por OP e regra: `U_Rule`, `U_WOEntry`, `U_ItemCode`, `U_BasisQty`, `U_BasisTotal`, `U_Share`, `U_Amount`, `U_QtyReceived`, `U_QtyInStock`, `U_AmtStock`, `U_AmtCPV`, `U_AmtVariance`
- `FBO_GGF_RUN3` — documentos gerados: `U_ObjType` (30 = lançamento contábil, 162 = reavaliação de estoque), `U_DocEntry`, `U_Status`, `U_Hash`, `U_ReversedBy`

### 4.3 Montante de GGF do período
Por regra ativa: soma de `Debit − Credit` das linhas de lançamento contábil (`JDT1`) nas contas da regra, com `RefDate` no mês, aplicando dimensões e filial.
- **Excluir** lançamentos gerados pela própria suíte (`Ref3` com prefixo `FO-GGF`) para não ratear o que já foi rateado.
- Uma conta não pode estar em duas regras ativas com filtros sobrepostos (validação no cadastro).

### 4.4 Critérios de rateio (`U_Basis`)
Sobre as **OPs com movimento no período** (competência):

| Código | Base por OP | Fonte |
|---|---|---|
| `LABOR_HOURS` | horas de recursos tipo Mão de obra consumidas | saídas para produção (`OIGE/IGE1`, base = OP) + recursos (`ORSC.ResType`) |
| `MACHINE_HOURS` | horas de recursos tipo Máquina | idem |
| `QTY_PRODUCED` | quantidade recebida no período × peso da linha da regra, se houver | `OIGN/IGN1` com base = OP |
| `WEIGHT_PRODUCED` | quantidade recebida × peso do item | `IGN1` × `OITM.SWeight1` |
| `MATERIAL_COST` | custo dos componentes consumidos | `IGE1` (itens) |
| `DIRECT_COST` | material + recursos | `IGE1` |
| `MANUAL_PCT` | percentual fixo por chave | linhas da regra |
| `EQUAL` | parcela igual por OP | — |

**[CONFIRMAR]** nomes exatos de campos e como diferenciar linha de item e de recurso na versão do cliente. Escrever as consultas em `/setup/ggf/sql-queries` e testá-las antes de ligar ao motor.

OPs elegíveis: Padrão e Especial. Desmontagem fora do MVP. Canceladas nunca entram.

### 4.5 Cálculo
```
share(op) = base(op) / Σ base(OPs elegíveis da regra)
valor(op) = round(montanteRegra × share(op), decimais)
```
- **Arredondamento** pelo maior resto: a diferença de centavos vai para a OP de maior valor, garantindo `Σ valor(op) = montanteRegra`.
- `Σ base = 0` → a regra não é rateada; vira **resíduo** em destaque; o usuário decide ignorar ou lançar em `U_AcctVariance`.
- Montante negativo é rateado com o sinal.

### 4.6 Destino do valor (modo `STOCK_THEN_CPV`)
```
qtdEmEstoque = min(qtdRecebidaNoPeríodo, estoqueAtual do item no depósito de entrada)
valorEstoque = valor(op) × qtdEmEstoque / qtdRecebidaNoPeríodo
valorCPV     = valor(op) − valorEstoque
```
- `valorEstoque` → **Reavaliação de estoque** (`MaterialRevaluation`, débito/crédito) por item+depósito, contrapartida = `U_AcctContra`. MVP: só itens de **custo médio**; FIFO/Padrão e lote/série bloqueados com mensagem clara **[CONFIRMAR]**.
- `valorCPV` → **Lançamento contábil** (`JournalEntries`): D CPV / C contrapartida.
- Sem estoque e modo `ALL_VARIANCE` → tudo em `U_AcctVariance`.
- Agrupar reavaliações por item+depósito.

### 4.7 Contabilização
- Gerar primeiro um **plano de lançamentos** (lista pura, cada documento com `hash` determinístico) e mostrar ao usuário antes de confirmar.
- Enviar via **`$batch` com changesets**. Em falha: status `ERROR`, mensagem na `FBO_GGF_RUN3`, e **retomada** sem reenviar documentos já gravados (idempotência pelo `hash`).
- Referências: `Ref3 = "FO-GGF-2026-09"`, `Memo = "FactoreOne GGF apuração <DocEntry>"`.
- Data = último dia do mês (configurável). Validar período contábil aberto antes de começar.
- Registrar início/fim/resultado em `FBO_LOG`.

### 4.8 Estorno
- Só a **última** apuração contabilizada, se `U_Sequential = Y`.
- Lançamento contábil → lançamento inverso. Reavaliação → nova reavaliação com valor inverso.
- Status `REVERSED`; originais e estornos vinculados na `FBO_GGF_RUN3`.

### 4.9 Validações
- Uma apuração ativa por mês/filial.
- `U_Sequential = Y` → mês anterior `POSTED`.
- Período contábil do B1 aberto.
- OP do período com item de método de custo não suportado → bloquear e listar.
- Autorizações `GGF_CONFIG`, `GGF_RUN`, `GGF_POST` via núcleo.

### 4.10 Telas
1. **Configuração GGF** — formulário.
2. **Regras de Rateio** — lista + detalhe; botão "Validar sobreposição".
3. **Apurações** — lista com filtros por período, filial, status.
4. **Detalhe da Apuração** — cabeçalho com ações **Buscar saldos → Simular → Contabilizar → Estornar** conforme status; seções *Saldos por conta*, *Rateio por OP* (exportar Excel), *Plano de lançamentos*, *Documentos gerados* (com link para o documento no Web Client), *Log/erros*.
5. **Relatório Custo Real da OP** — material + recursos + GGF = total e unitário.
6. *(Fase 3)* **UI API extension** na Ordem de Produção: painel "GGF apropriado".

Textos sempre via i18n (pt_BR padrão).

---

## 5. Módulo Industrialização (`ind`) — reservado

**Não implementar agora.** Escopo previsto, a ser especificado em detalhe quando for a vez:
- remessa para industrialização e retorno (físico e simbólico) com terceiros;
- beneficiamento (a empresa industrializa para terceiros);
- controle de saldo em poder de terceiros e de terceiros em poder da empresa;
- vínculo com Ordens de Produção e custo (reaproveitando o núcleo e, quando fizer sentido, o custo real calculado pelo módulo GGF via **núcleo**, não por import direto).

O que fazer desde já para não travar esse módulo:
- Manter serviços de documentos de estoque/marketing e de parceiros de negócio no **núcleo**, genéricos.
- Não acoplar o motor do GGF a telas nem a detalhes que o `ind` precisaria mudar.

---

## 6. Fases

- **Fase 0 — Núcleo:** scaffold pelo plugin SAP, `ServiceLayerClient`, `MetadataInstaller`, `FBO_SETUP`/`FBO_LIC`/`FBO_LOG`, tile de instalação, `money.ts` com testes. Validar o ciclo completo: build do `.mtar` → Extension Manager → abrir no Web Client.
- **Fase 1 — GGF MVP:** configuração, regras (`QTY_PRODUCED`, `LABOR_HOURS`, `MACHINE_HOURS`, `MATERIAL_COST`), apuração com simulação e memória de cálculo. **Sem contabilização.**
- **Fase 2 — GGF contabilização:** plano de lançamentos, reavaliação + CPV, idempotência, estorno.
- **Fase 3 — GGF extras:** demais critérios, relatório de custo real, UI API extension na OP, multifilial.
- **Fase 4 — GGF antecipado:** taxa padrão na entrada do PA e ajuste no fechamento (especificar ao chegar).
- **Fase 5+ — Industrialização:** especificar e implementar.

Não avance de fase sem a anterior testada e revisada.

---

## 7. Como trabalhar neste repositório (regras para o Claude Code)

- **Pergunte antes** de decidir qualquer **[CONFIRMAR]**; registre a decisão na seção 9.
- **Motores primeiro, com testes.** Para o GGF, cobrir: rateio simples, resíduo de arredondamento, base zero, montante negativo, OP parcialmente vendida, OP 100% vendida, várias regras sobre as mesmas OPs.
- Motores recebem dados já carregados e devolvem resultado + plano de lançamentos. Nada de HTTP dentro de `/engine`.
- Respeite a regra de ouro (1.1): módulo não importa módulo.
- **Nunca** faça POST/PATCH no Service Layer de ambiente que não seja explicitamente de desenvolvimento/teste. URL e credenciais via variáveis de ambiente / `.env` fora do git.
- TypeScript estrito; controllers UI5 finos; lógica em services/engine.
- Nome do produto, prefixo e versão só em `product.ts` e i18n.
- Cada tarefa termina com testes passando, lint limpo e resumo do que mudou e do que ficou pendente.
- Se algo do SAP B1 não puder ser confirmado, **não chute**: deixe `TODO [CONFIRMAR]` e avise.

---

## 8. Prompt inicial sugerido para o Claude Code

> Leia o CLAUDE.md inteiro. Estamos na Fase 0. Verifique se o scaffold do plugin SAP B1 Web Client já existe no repositório; se não existir, pare e me avise. Depois liste as premissas [CONFIRMAR] que bloqueiam as Fases 0 e 1 (inclusive a decisão 2.3, um app ou vários) e me faça as perguntas de uma vez. Em seguida reorganize o scaffold conforme 2.4 e implemente o núcleo com `money.ts` testado, sem telas do GGF ainda.

---

## 9. Decisões registradas

| Data | Decisão | Motivo |
|---|---|---|
| 2026-09-25 | Nome de trabalho "Fabrica One"; produto estruturado como suíte (núcleo + módulos) | Expansão futura para industrialização |
| 2026-09-25 | Ambiente: Node 24 LTS, npm 11, GNU Make 4.4.1, mbt 1.2.47 | Setup concluído |
| 2026-09-25 | Opção 2.3-A: um app UI5 com vários tiles, um único `.mtar` | Simplicidade de manutenção e licenciamento pelo núcleo |
| 2026-09-25 | Banco: SAP HANA, B1 versão FP 2608 | Define o dialeto das `SQLQueries` |
| 2026-09-25 | Sessão do Service Layer via SSO do Web Client | — |
| 2026-09-25 | Prefixo de tabelas `FBO_` (antes `FO_`). O prefixo de referência em documentos (`Ref3`) continua `FO-` | Decisão do responsável |
| 2026-09-25 | Licenciamento MVP: flag por módulo, isolada em `License.ts` para trocar pela licença real depois sem tocar nos módulos. Sem trabalho de proteção antes do primeiro cliente | Foco em ter o produto funcionando |
| 2026-09-25 | Autorizações: usar as autorizações definidas pelo usuário do B1, criadas pelo instalador do núcleo. **Validar que funcionam na FP 2608**; plano B: tabela própria `FBO_PERM` | Pendente de validação no ambiente |
| 2026-09-25 | Config de integração por cliente em variáveis de ambiente `FBO_*` (`.env` fora do git, modelo em `.env.example`), lida por `core/config/integration.ts`. Escrita no SL só com `FBO_ENV` = `dev`/`test` | Regra da seção 7 |
| 2026-09-25 | Fase 0 começa sem o Service Layer (fora do ar): `money.ts`, `License.ts`, `product.ts`, config de integração, com testes. O `.env` entra na hora de testar a integração | Servidor de dev indisponível |
| 2026-09-25 | `ServiceLayerClient` (`core/service`): sessão atrás da interface `SessionProvider`; renovação reativa (401 ou código 301) com uma nova tentativa; `$batch` com changesets; erros traduzidos. A trava de escrita por `FBO_ENV` vale só para sessão por credenciais (ferramentas/testes); a sessão SSO do Web Client não passa por ela | Escrita em produção é a operação normal do cliente; a trava protege só o uso do `.env` |
| 2026-09-25 | Pendente de validar com o servidor: caminho base `/b1s/v2`, código de sessão expirada (301), formato exato do `$batch` aceito pelo SL, implementação de SSO do `SessionProvider` | Testes usam `fetch` simulado; nenhuma chamada real foi feita |
| 2026-09-26 | Nome do produto: **FactoreOne** (antes "Fabrica One"). Prefixo de tabelas `FBO_` mantido até o responsável decidir se muda | Decisão do responsável |
| 2026-09-26 | Scaffold **manual, sem wizard**, no formato do template Fiori do wizard 1.5.0 do SDK da FP 2608 (1 módulo `fiori-app`, `path: .`, `npm run compress`). O exemplo oficial de 2021 (FP 2105) fica só como comparação | Decisão do responsável; o wizard só empacota app pronto e não builda UI5 |
| 2026-09-26 | Build do app: `@ui5/cli` 4 + `ui5-tooling-transpile` (TypeScript), sem `ui5-task-zipper`, `webide-extension`, `xs-app.json` nem `@sap/ux-ui5-tooling`. Tile (`WebClientExtension.json`) gerado por script a partir de `product.ts` + i18n. ID do MTA `ext-factoreone`, namespace UI5 `factoreone.app` | Manter o formato do resultado com ferramental atual (Node 24 + TS); nomes estáticos cobertos por teste |
| 2026-09-26 | Primeiro `.mtar` construído com `mbt build`; a tela inicial é a do FactoreOne (nome, versão, módulos e licença), sem conteúdo de exemplo (88 testes e typecheck ok). **Pendente:** importar no Extension Manager e abrir no Web Client; `minUI5Version`/tema `[CONFIRMAR]`; `npm audit` aponta só dependências de desenvolvimento (vitest 2, `@ui5/cli`) | Sem acesso ao ambiente B1 nesta máquina |
| 2026-09-26 | Instalador de metadados do núcleo (Fase 0): definições declarativas em TS tipado (`webapp/core/data/definitions/`), **não** em `/setup/*.json`; planejador puro (`plan.ts`) + `MetadataInstaller` (lê, planeja, executa em POSTs sequenciais: tabelas → campos → objetos; para na primeira falha; nunca apaga nem altera; divergência de campo vira aviso). Versão instalada por módulo na `FBO_SETUP`, gravada só depois de tudo criado | O UI5 só empacota `webapp/`; JSON fora dele não iria no `.mtar`. Retomada por reexecução (o plano é recalculado do que existe) |
| 2026-09-26 | `FBO_SETUP`, `FBO_LIC` e `FBO_LOG` modeladas como MasterData com UDO (Code = módulo em SETUP/LIC; LOG a definir). `FBO_LIC` só com `U_Enabled` (Y/N). **Não validado no servidor:** nomes de propriedades/enums de `UserTablesMD`/`UserFieldsMD`/`UserObjectsMD`, nome da entidade do UDO, HTTP 404 para tabela/objeto inexistente, formato do `nextLink`, limite de nome de UDF (18) e de campo alfa (254). Testes usam um Service Layer simulado em memória; nenhuma chamada real | Sem servidor de dev no ar; tudo isolado em `plan.ts` e `SetupRepository.ts` para ajustar sem tocar no resto |
