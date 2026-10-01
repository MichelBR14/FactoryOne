# Exposicao do UDO FBO_GGF_CVERS na Service Layer

## Validacao pos-reinicio e PPLAN - 01/10/2026

O usuario confirmou o restart da Service Layer. A bateria inicial de 100 sessoes para os quatro UDOs existentes passou (evidencias de 30/09 descritas abaixo). Na primeira tentativa apos criar PPLAN, o certificado TLS estava expirado e a SL inacessivel. Com autorizacao expressa do usuario, as rotinas locais de homologacao passaram a aceitar o certificado expirado usando um `https.Agent` dedicado, mantendo criptografia HTTPS, sem `NODE_TLS_REJECT_UNAUTHORIZED=0`, sem HTTP e sem mudar a confianca TLS global. O modo exige `FBO_SL_ALLOW_INVALID_CERTIFICATE=1` na invocacao, empresa `SBODEMOBR2`, ambiente dev/test e endpoint HTTPS; nas sessoes de escrita so permite metadata PPLAN, versao do schema GGF e snapshot PPLAN bloqueado. Escritas de financeiro, OP, estoque e outros UDOs falham fechadas. Evidencia registra `tlsVerified=false` para nao confundir a excecao com validacao de identidade do servidor.

Exemplo de invocacao local: `FBO_SL_ALLOW_INVALID_CERTIFICATE=1 node scripts/ggf-closing-metadata.mjs verify-exposure`. Nao grave essa excecao em `.env`, nao a use em producao e nao a combine com `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Com a excecao local, `$metadata` mostrou `FBO_GGF_PPLAN`; `FBO_GGF_PPLAN/$count` HTTP 200 (0 antes do snapshot) e `UserObjectsMD` confirmou `ApplyAuthorization=tYES`, `CanDelete=tNO`. `verify-exposure` passou em 16 sessoes GGF nos quatro nos e 8 sessoes core nos nos 2, 3 e 4. Duas baterias PPLAN de 50 sessoes independentes, separadas por cerca de seis minutos, passaram 50/50 cada; nos 1-4 observados; metadata/endpoints/versionamento legados consistentes; zero `Service Not Found`. Evidencias sanitizadas: `.local/ggf/udo-sl-stability-2026-10-01T11-59-32.786Z.json` e `.local/ggf/udo-sl-stability-2026-10-01T12-06-10.680Z.json`.

Nova execucao idempotente do instalador reportou `created=0`, sem divergencias; releu exposicao nos cinco UDOs e registrou GGF schema v3 em `FBO_SETUP`. O PostingPlan tecnico foi persistido e lido de volta numa sessao independente, depois relido em mais tres logins sequenciais com hash/totais/linhas identicos. Tres leituras simultaneas tiveram um erro HTTP 500 no login; isso nao produziu divergencia, mas concorrencia deve ser homologada separadamente. O unico POST de dados foi o UDO PPLAN; nenhum documento financeiro, claim, OP ou estoque foi alterado.

**Conclusao:** a estabilidade multi-node do PPLAN esta homologada para as amostras pos-instalacao sob a excecao local TLS acima. A autenticidade do certificado nao foi validada; antes de retirar essa excecao, renovar o certificado e repetir ao menos o smoke read normal. Nao remover a protecao `SAP_METADATA_UNAVAILABLE` do produto.

## Resultado em 29/09/2026

**Causa imediata comprovada:** a Service Layer entregou `$metadata` sem `FBO_GGF_CVERS` em uma sessao na qual `UserObjectsMD('FBO_GGF_CVERS')` retornou HTTP 200 e `FBO_GGF_CLOSE` continuou legivel. Logo, o UDO existe no SAP; o problema e a exposicao/metadados da Service Layer, nao ausencia do registro. Em tentativas anteriores, o GET do UDO retornou HTTP 400, codigo `-1002`, `Service Not Found`. **O processo/no responsavel pelo cache desatualizado ainda nao foi identificado**; a evidencia disponivel nao permite declarar a causa operacional final nem afirmar que o ambiente foi reparado.

Nenhuma escrita no SAP foi feita nesta investigacao. O fechamento tecnico `F1HL260929F` e suas duas versoes existentes foram apenas relidos. Nenhum MaterialRevaluation, Journal Entry ou metadado novo foi criado.

## Reproducao controlada

`node scripts/ggf-udo-sl-stability.mjs 20` abre sessoes independentes, preserva o `ROUTEID` recebido para as leituras daquela sessao, encerra cada login e registra somente um rotulo `sNN`, numero de rota, impressao SHA-256 abreviada da rota e respostas sanitizadas. Nao grava `B1SESSION`, cookies, usuario ou senha. Por sessao, consulta `$metadata`, `UserObjectsMD('FBO_GGF_CVERS')`, um fechamento antigo estavel e a versao `F1HL260929F.00001`.

| Amostra UTC | Sessoes | GET versao 200 | Evidencia contraria |
| --- | ---: | ---: | --- |
| 16:41 | 20 | 19 | Sessao `s19`: metadata HTTP 200 sem `FBO_GGF_CVERS`; registro do UDO e CLOSE HTTP 200; socket fechou antes do GET da versao. |
| 16:43 | 30 | 30 | Nenhuma nessa amostra. |
| 16:44 | 20 | 20 | Nenhuma nessa amostra. |
| Verificacao de exposicao posterior | 16 | 16 | Os quatro UDOs responderam em cada sessao; rotas 1 a 4 observadas. |

Evidencia bruta, ignorada pelo Git: `.local/ggf/udo-sl-stability-2026-09-29T16-41-00.419Z.json`, `.local/ggf/udo-sl-stability-2026-09-29T16-43-14.665Z.json` e `.local/ggf/udo-sl-stability-2026-09-29T16-44-22.103Z.json`. Os arquivos incluem apenas dados sanitizados da consulta tecnica. A verificacao final foi `node scripts/ggf-closing-metadata.mjs verify-exposure`; o plano `plan` mostrou zero acoes e zero divergencias.

## Registro e topologia

`FBO_GGF_CVERS`, `FBO_GGF_CLOSE`, `FBO_GGF_CLINE` e `FBO_GGF_CLAIM` foram relidos de `UserObjectsMD`. Todos sao `boud_MasterData`, com tabela principal de mesmo codigo, sem tabelas filhas, `CanFind=tNO`, `CanCreateDefaultForm=tNO`, `ManageSeries=tNO`, `ApplyAuthorization=tYES`, `CanDelete=tNO` e `CanLog=tNO`. A diferenca de nome/descricao nao explica uma falha de exposicao. As duas versoes de `CVERS` continuam persistidas.

O `ROUTEID` revelou rotas `.node1` a `.node4`. O endpoint SAP `/ping/node/1` e `/ping/node/4` retornou 200; `/ping/node/2` e `/ping/node/3` retornou 503. **Isso nao prova que as sessoes de rota 2/3 foram atendidas pelos processos 2/3:** ambas fizeram GET com sucesso, e a Service Layer pode redirecionar requisicoes a outro membro ativo. A mesma rota 3 teve metadata atualizada em outras sessoes. Sao necessarios logs do balanceador e dos membros com no/PID/hora para correlacionar a resposta antiga. O caminho documentado `/ServiceLayerController` respondeu 404 neste endereco; nao houve acesso administrativo nem reinicio por este projeto.

O [manual SAP da Service Layer](https://help.sap.com/doc/fc2f5477516c404c8bf9ad1315a17238/10.0/en-US/Working_with_SAP_Business_One_Service_Layer.pdf) documenta `$metadata` para UDOs, `ROUTEID`, endpoints `/ping/node/N`, controlador, redistribuicao por balanceador e a limitacao de que UDO/UDF/UDT novo pode exigir reinicio da Service Layer. Nao foi encontrado um refresh OData suportado que substitua esse reinicio para UDO novo. O controlador pode nao administrar todos os membros em instalacao distribuida.

## Correcao no FactoryOne

- `SapGgfClosingVersionRepository` trata HTTP 400/`-1002` ou `Service Not Found` como `SAP_METADATA_UNAVAILABLE`, nunca como UDO inexistente. Nao recria metadados nem tenta um POST substituto.
- `GgfPostingCoordinator` exige a disponibilidade do UDO antes de `READY_TO_POST` e novamente antes de criar claim/enviar documento. O botao de contabilizacao continua indisponivel; o teste comprova zero claim e zero chamada financeira quando a verificacao falha.
- A consulta local de integridade exige o endpoint do UDO e, para fechamento FIFO, relê o snapshot ativo. Em falha de metadata retorna HTTP 503 com codigo sanitizado; a tela mostra bloqueio e permite nova consulta. Nenhum resultado antigo e apresentado como verificado.
- `MetadataInstaller.install` aceita prova de exposicao **apos** as criacoes e **antes** de gravar `FBO_SETUP`. O instalador GGF abre sessoes novas, relê o registro do objeto e `/$count` de cada UDO (16 sessoes GGF). Se qualquer uma falhar, a migracao nao conclui nem grava uma versao nova. Uma nova execucao continua das criacoes ja existentes; nao as duplica. A versao 2 ja registrada anteriormente nao foi alterada nesta etapa.

## Procedimento de implantacao

1. Antes da migracao, registrar estado de `/ping/load-balancer`, `/ping/node/N`, plano `ggf-closing-metadata.mjs plan` e janelas de manutencao. Nao interpretar `ROUTEID` isolado como prova do processo que atendeu a chamada.
2. Criar metadados pelo instalador. Se a exposicao falhar, manter a versao nao concluida e a contabilizacao bloqueada; nao recriar o UDO manualmente.
3. Um administrador do host SAP deve conferir logs de todos os membros e do balanceador. Se necessario, fazer **reinicio controlado de todos os membros relevantes** pelo procedimento suportado para aquela instalacao, durante janela aprovada. Reiniciar apenas o balanceador nao demonstra que caches dos membros foram atualizados. Este projeto nao executou reinicio porque o controlador nao estava acessivel e nao havia canal administrativo comprovado.
4. Repetir `node scripts/ggf-udo-sl-stability.mjs 40` e `node scripts/ggf-closing-metadata.mjs verify-exposure`. Exigir metadata e GET consistentes em todas as rotas observadas, leitura das versoes 1/2 em sessoes novas e verificacao do estado dos membros. Um unico sucesso ou uma sessao aquecida nao bastam.

**Decisao de producao:** `FBO_GGF_CVERS` **ainda nao pode ser considerado seguro para contabilizacao em producao**. O fallback protege o FactoryOne, mas nao corrige o estado intermitente do servico. A liberacao depende da investigacao operacional dos logs, eventual reinicio controlado e novo teste multi-sessao sem falhas. A regra contabil da parcela FIFO consumida permanece pendente por outro motivo.

Verificacoes de codigo: `npm test` **485/485** em 36 arquivos, `npm run typecheck` aprovado, `npm run build` aprovado e Playwright completo **30/30**. O build gerou `mta_archives/ext-factoreone_0.1.0.mtar` com aviso de relogio do WSL (*clock skew*). A captura do bloqueio mobile esta em `.local/ggf/visual/ggf-metadata-unavailable-390.png`; ela usa resposta controlada HTTP 503 e nao simula um fechamento contabilizado no SAP.

## Janela controlada: registro pre-reinicio de 29/09/2026

As 21:45-21:48 UTC (18:45-18:48 em Sao Paulo), antes de qualquer reinicio nesta janela:

- Login HTTPS com certificado validado na `SBODEMOBR2`; `Version` retornada pelo SAP: `1000340`.
- `$metadata` HTTP 200 contendo os quatro UDOs. `UserObjectsMD` e `/$count` retornaram HTTP 200 para `FBO_GGF_CLOSE` (5 registros), `FBO_GGF_CLINE` (8), `FBO_GGF_CLAIM` (2) e `FBO_GGF_CVERS` (2). As versoes tecnicas `F1HL260929F.00001` e `.00002` foram relidas com HTTP 200.
- `/ping/load-balancer`, `/ping/node/1` e `/ping/node/4`: HTTP 200; `/ping/node/2` e `/ping/node/3`: HTTP 503. `/balancer-manager` respondeu HTTP 200 e anunciou quatro membros (`node1` a `node4`) com estado `Init Ok`, apesar dos dois pings 503. Essa contradicao deve ser verificada no host, sem deduzir que os processos 2/3 estao parados.
- `/ServiceLayerController` respondeu HTTP 404 neste endereco. A lista de servicos/PIDs no sistema operacional e o estado dos logs **ainda nao foram obtidos**, pois o acesso administrativo ao host sera fornecido separadamente.
- Duas sessoes independentes adicionais passaram com metadata e versoes 1/2; evidencia sanitizada em `.local/ggf/udo-sl-stability-2026-09-29T21-48-30.110Z.json`.

O balanceador respondeu com banner Apache `Unix`, mas isso nao substitui a identificacao do sistema operacional e das unidades de servico no host. O [guia SAP para Linux/HANA](https://help.sap.com/doc/4e7c047f2c9e4cbe97800ffaf7b68f8e/10.0/en-US/B1_for_SAP_HANA_Admin_Guide.pdf) documenta `systemctl restart b1s<Port>` para um membro; o [guia SAP para Windows/SQL](https://help.sap.com/doc/63f7851fd3984ec492bbb75d94a6bb9b/10.0/en-US/AdministratorGuide_SQL.pdf) documenta `b1s<Port>.bat restart`. O [manual da Service Layer](https://help.sap.com/doc/fc2f5477516c404c8bf9ad1315a17238/10.0/en-US/Working_with_SAP_Business_One_Service_Layer.pdf) observa que o Controller pode nao gerenciar todos os membros numa instalacao distribuida. O comando aplicavel so sera escolhido depois de comprovar plataforma, hosts e portas reais; nao reiniciar banco ou outros servicos SAP.
