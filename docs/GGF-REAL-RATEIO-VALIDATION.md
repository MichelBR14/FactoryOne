# GGF - primeira validacao real do rateio

## Resultado e escopo

**Validacao matematica: PASSOU nos dois cenarios. Validacao funcional de GGF:
NAO aprovada por esta execucao, ainda depende do cliente.**

Fluxo executado: Service Layer real da **SBODEMOBR2** -> adaptador
`SapGgfCalculationSource` -> `ClosingSession`/motor aprovado -> memoria JSON/CSV
-> conferencia independente com Python `Decimal`/`Fraction` sobre as respostas
SAP preservadas. Nenhum dado ficticio entrou nessas execucoes.

Periodo: **01/09/2026 a 30/09/2026**, com setembro ainda aberto. Capturas de
**28/09/2026, 15:46:32 a 15:46:36 UTC (12:46:32 a 12:46:36 em Sao Paulo)**.
Nao representa fechamento definitivo nem movimentos posteriores a esse instante.

Conectividade/autenticacao: aprovadas; `/b1s/v2`, versao retornada no login
`1000340`, TLS verificado pelo transporte HTTPS, sem desabilitar certificado.
Credenciais e cookies nao constam dos artefatos. Foram **72 GETs de negocio**,
mais Login/Logout para a sessao. Nenhuma escrita de negocio, SQL, instalacao de
metadados ou instalacao no Web Client. O motor e o adaptador nao foram alterados.

## Conta de validacao tecnica

| Campo | Valor |
|---|---|
| Conta real | 4.01.02.01.01 |
| Nome no SAP | Variacoes Cambiais Passivas (acentuacao original preservada no JSON) |
| Classificacao LOCAL do teste | CONTA DE VALIDACAO TECNICA - NAO GGF FUNCIONAL |
| Debito no periodo | 37956 centavos = R$ 379,56 |
| Credito no periodo | 0 centavos |
| Saldo do periodo, debito menos credito | 37956 centavos |
| Percentual configurado | 75% |
| Valor submetido ao rateio | 37956 x 75 / 100 = **28467 centavos** |
| Ajuste na aplicabilidade | 0: resultado ja tem centavos inteiros |
| Parcela nao submetida | 9489 centavos; nao redistribuida |
| Filtros | Datas; sem restricao de filial/dimensao |

Motivo: o diagnostico aprovado nao demonstrou gasto elegivel nas contas
industriais indiretas. Esta conta financeira tem movimento real e um saldo
positivo simples de reproduzir, sem vinculo comprovado com as tres OPs.
Ela foi escolhida **somente para testar o mecanismo**, conforme autorizacao do
usuario para esse caso. Nao foi reclassificada como GGF nem configurada no SAP.
O percentual de 75% tambem e parametro tecnico de teste, nao politica oficial.
Nao houve nova auditoria generica ou escolha automatica de pool industrial.

A conta **4.01.01.04.07 nao foi usada**. Continua sob risco de dupla absorcao.
Tambem nao se usaram estoque, produtos em elaboracao ou variancias das OPs como
gasto adicional. O recurso consumido participa apenas do denominador de custo
documentado deste teste; nao vira despesa do pool.

### Origem do saldo

Nome/codigo: `ChartOfAccounts('4.01.02.01.01').Name/Code`, cadastro atual.
Saldos: `JournalEntries`, data `ReferenceDate`, identificador `JdtNum` usado como
TransId; campos `JournalEntryLines[Line_ID].AccountCode/Debit/Credit`.

| TransId / Line_ID | ReferenceDate | Debito (centavos) | Credito (centavos) | Filial BPLID | Dimensoes 1..5 | OP relacionada |
|---|---|---:|---:|---:|---|---|
| 2192 / 9 | 2026-09-03 | 37956 | 0 | 1 | Strings vazias | Nenhuma comprovada |
| 2220 / 2 | 2026-09-17 | 0 | 0 | 1 | null | Nenhuma comprovada |
| 2236 / 2 | 2026-09-17 | 0 | 0 | 1 | null | Nenhuma comprovada |
| **Total** | Setembro/2026 | **37956** | **0** | | | |

As duas linhas zeradas nao foram omitidas. Tres lancamentos com linha da conta
nao significam tres lancamentos com valor local positivo. Nao se usaram
`DebitSys/CreditSys` ou `FCDebit/FCCredit`; moeda do teste e a moeda local SAP,
identificada no contrato como `SAP_LOCAL`. Documentos de producao retornam `R$`.
Nao houve conversao cambial nem alteracao de sinal.

## Cenario 1 - Absorcao por Custo Direto

Politica explicita: `DOCUMENTED_MATERIALS_AND_RESOURCES`. Base tecnica = soma
de `InventoryGenExits.DocumentLines.LineTotal` dos materiais e recursos
documentados contra cada OP. Conferida com o valor dos recebimentos; nao se
somam os recebimentos outra vez nem os lancamentos de fechamento.

| OP / AbsoluteEntry | Item | Materiais (centavos) | Recursos (centavos) | Custo direto considerado (centavos) | Recebimento (centavos) | Diferenca |
|---|---|---:|---:|---:|---:|---:|
| 76 / 203 | C00003 | 100058 | 450000 | **550058** | 550058 | 0 |
| 77 / 204 | z202604 | 9184 | 1700 | **10884** | 10884 | 0 |
| 79 / 206 | z202604 | 9181 | 1700 | **10881** | 10881 | 0 |
| **Total** | | **118423** | **453400** | **571823** | **571823** | **0** |

As tres ordens sao padrao, fechadas, com `PostingDate` e `ClosingDate` em
28/09/2026. `PlannedQuantity=1`, `CompletedQuantity=1`, `InventoryUOM=UN` em
`ProductionOrders(203/204/206)`. Fechamento da OP nao significa mes fechado.

### Composicao rastreavel, em centavos

Todas as linhas abaixo sao `InventoryGenExits.DocumentLines`, em documentos
com `DocDate=2026-09-28`, nao cancelados. Valor = `LineTotal`.
Identificacao = DocEntry/LineNum; ligacao = `BaseType=202`, `BaseEntry` da OP e
`BaseLine` da linha em `ProductionOrderLines.LineNumber`. Quantidade `Quantity=1`
em todas essas linhas. `UnitPrice`, `MeasureUnit`, `InventoryQuantity`, data e
campos de vinculo estao preservados linha por linha no JSON independente.

| OP | DocEntry / LineNum | BaseLine | ItemCode | Tipo | LineTotal (centavos) |
|---|---|---:|---|---|---:|
| 76 | 77 / 0 | 1 | R300007 | Recurso | 450000 |
| 76 | 77 / 1 | 2 | A00001 | Material | 19820 |
| 76 | 77 / 2 | 3 | A00005 | Material | 3939 |
| 76 | 77 / 3 | 4 | C00005 | Material | 3492 |
| 76 | 77 / 4 | 5 | C00006 | Material | 3283 |
| 76 | 77 / 5 | 6 | C00007 | Material | 14840 |
| 76 | 77 / 6 | 7 | C00008 | Material | 33611 |
| 76 | 77 / 7 | 8 | C00009 | Material | 4452 |
| 76 | 77 / 8 | 9 | C00010 | Material | 3448 |
| 76 | 77 / 9 | 10 | C00011 | Material | 6824 |
| 76 | 77 / 10 | 11 | C00012 | Material | 1400 |
| 76 | 77 / 11 | 12 | C00013 | Material | 3578 |
| 76 | 78 / 0 | 13 | E00002 | Material | 1371 |
| 77 | 79 / 0 | 0 | R300010 | Recurso | 500 |
| 77 | 79 / 1 | 1 | R300011 | Recurso | 1200 |
| 77 | 79 / 2 | 2 | z202611 | Material | 1973 |
| 77 | 79 / 3 | 3 | z202613 | Material | 3923 |
| 77 | 79 / 4 | 4 | z202615 | Material | 3288 |
| 79 | 80 / 0 | 0 | R300010 | Recurso | 500 |
| 79 | 80 / 1 | 1 | R300011 | Recurso | 1200 |
| 79 | 80 / 2 | 2 | z202611 | Material | 1972 |
| 79 | 80 / 3 | 3 | z202613 | Material | 3922 |
| 79 | 80 / 4 | 4 | z202615 | Material | 3287 |

Materiais OP76: `19820+3939+3492+3283+14840+33611+4452+3448+6824+1400+3578+1371=100058`.
OP77: `1973+3923+3288=9184`; OP79: `1972+3922+3287=9181`.
Recursos: OP76 `450000`; OP77 e OP79 `500+1200=1700` cada.

`R300007` tem unidade cadastrada "horas", mas consumo backflush nao comprova
apontamento real. R300010/R300011 retornam unidade null. Nenhum desses dados
foi convertido em horas. Foi usado o valor monetario historico `LineTotal`,
nao `Resources.CostN` atual, nem quantidade de recurso como substituto de tempo.

### Recebimentos e conferencia da base

`InventoryGenEntries.DocumentLines`, `DocDate=2026-09-28`, `BaseType=202`,
`TransactionType=botrntComplete`, `UseBaseUnits=tYES`, `Quantity=InventoryQuantity=1`.

| OP | DocEntry / LineNum | BaseEntry | ItemCode | MeasureUnit | InventoryQuantity | LineTotal (centavos) |
|---|---|---:|---|---|---:|---:|
| 76 | 109 / 0 | 203 | C00003 | UN | 1 | 550058 |
| 77 | 110 / 0 | 204 | z202604 | UN | 1 | 10884 |
| 79 | 111 / 0 | 206 | z202604 | UN | 1 | 10881 |

O custo unitario historico observado e respectivamente `550058/1`, `10884/1`
e `10881/1` centavos/UN. Nao e custo atual do estoque; `currentCost` e custo
resultante permanecem null na execucao SAP.

### Memoria e comparacao independente

```text
Base total = 550058 + 10884 + 10881 = 571823 centavos
Valor aplicavel = 37956 x 75 / 100 = 28467 centavos
Participacao OP = base OP / 571823
Quota bruta OP = 28467 x base OP / 571823 centavos
```

As fracoes abaixo sao exatas; percentuais/decimais exibidos sao apenas leitura.
Nao se arredonda a participacao antes de calcular o valor.

| OP | Participacao (%) | Quota bruta exata (centavos) | Bruto aproximado (centavos) | Truncado | Ajuste inteiro | Motor final | Independente final | Diferenca |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| 76 | 96,193752 | 15658501086 / 571823 | 27383,475456566105 | 27383 | 0 | **27383** | **27383** | 0 |
| 77 | 1,903386 | 309834828 / 571823 | 541,836946047990 | 541 | +1 | **542** | **542** | 0 |
| 79 | 1,902862 | 309749427 / 571823 | 541,687597385904 | 541 | +1 | **542** | **542** | 0 |
| **Total** | **100** | | **28467** | **28465** | **+2** | **28467** | **28467** | **0** |

Restos com denominador comum 571823: OP76=271877, OP77=478585, OP79=393184.
Os dois centavos residuais vao para OP77 e OP79, nessa ordem, pelos maiores
restos. Ajustes **em relacao a quota bruta**, diferentes do ajuste apos truncar:
OP76 `-271877/571823`; OP77 `+93238/571823`; OP79 `+178639/571823` centavos.

Fechamento: **a distribuir 28467; distribuido 28467; diferenca 0 centavos**.
Em reais: OP76 R$273,83; OP77 R$5,42; OP79 R$5,42.

## Cenario 2 - Quantidade Produzida

Nova execucao de leitura e calculo, **alternativa**, nao cumulativa com o cenario1.
Mesma conta, saldo, periodo e percentual: 28467 centavos a distribuir.
Somente OP77/79: mesmo produto `z202604`, mesma unidade `UN`, recebimentos
completos e quantidades de estoque conferidas. **OP76 excluida deste cenario**:
`C00003` e outro produto e nao ha equivalencia funcional aprovada. A sigla UN,
sozinha, nao autoriza incluir produtos heterogeneos.

| OP | Fonte | Quantidade | Unidade | Participacao | Quota bruta (centavos) | Truncado | Ajuste inteiro | Motor | Independente | Diferenca |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 77 | InventoryGenEntries(110), linha0 | 1 | UN de z202604 | 50% | 28467/2 = 14233,5 | 14233 | +1 | **14234** | **14234** | 0 |
| 79 | InventoryGenEntries(111), linha0 | 1 | UN de z202604 | 50% | 28467/2 = 14233,5 | 14233 | 0 | **14233** | **14233** | 0 |
| **Total** | | **2** | UN de z202604 | **100%** | **28467** | **28466** | **+1** | **28467** | **28467** | **0** |

Campo da base: `DocumentLines.InventoryQuantity`, nao quantidade planejada.
Contrato usa seis casas: cada OP=1000000 micro-unidades, total=2000000;
a razao e exatamente a mesma que1/2. Empate de restos: chave estavel "204"
antes de "206". Ajustes contra quota bruta: +1/2 e -1/2 centavo.
Resultado em reais: R$142,34 e R$142,33; diferenca global zero.

## Como a conferencia e independente

`scripts/ggf-independent-check.py` nao importa motor, adaptador ou utilitarios
monetarios do FactoryOne e nao consulta rede. Rele as respostas capturadas com
`Decimal`, reconstitui saldo, materiais, recursos e recebimentos, confere
quantidades emitidas/concluidas e calcula as quotas com `Fraction`.

Compara linha a linha: identidade da OP/conta, composicao, base, base total,
percentual, valor aplicavel, unidade/escala, participacao, resto, ajuste de
centavos, valor final por OP e totais. Os valores esperados nao vem do snapshot
normalizado pelo adaptador: sao derivados novamente das linhas SAP.
Confere ainda debito=credito dos67 lancamentos lidos e o SHA-256 da captura.

Os testes do conferidor usam dados inventados e injetam divergencias de base,
componente, participacao, ajuste e resultado. Assim, uma diferenca zero alegada
pelo motor nao basta para o teste independente passar.

### Completude e releituras

| Entidade | Custo direto: registros / paginas | Quantidade: registros / paginas | Escopo |
|---|---|---|---|
| ChartOfAccounts | 1 / 1 | 1 / 1 | Apenas a conta tecnica |
| JournalEntries | 67 / 4 | 67 / 4 | ReferenceDate de setembro;497 linhas; saldo selecionado depois |
| ProductionOrders | 3 / 1 | 2 / 1 | Chaves203/204/206 ou204/206 |
| InventoryGenEntries | 3 / 1 | 3 / 1 | DocDate de setembro; vinculos das OPs selecionados depois |
| InventoryGenExits | 4 / 1 | 4 / 1 | DocDate de setembro; vinculos das OPs selecionados depois |
| Resources | 8 / 1 | 8 / 1 | Cadastros atuais, sem falso filtro historico |
| ResourceGroups | 1 / 1 | 1 / 1 | Cadastros atuais |

Cada colecao tem `$count` separado, repetido ao final, sem IDs duplicados e sem
paginas pendentes. As linhas excluidas do recorte ficam identificadas no snapshot.
Houve14 releituras individuais no custo e10 na quantidade, com a mesma projecao:
conta, lancamentos da conta e documentos/OPs que compoem as bases. Nenhuma
diferenca entre colecao e documento individual foi encontrada. Foram38 e34 GETs.

Consultas reais completas, `$select`, filtros, continuacoes, horarios e
respostas ficam em `*-source.json`. Exemplos de filtros, antes da codificacao:

```text
JournalEntries: ReferenceDate ge '2026-09-01' and ReferenceDate le '2026-09-30'
InventoryGenEntries/InventoryGenExits: DocDate ge '2026-09-01' and DocDate le '2026-09-30'
ProductionOrders: AbsoluteEntry eq 203 or AbsoluteEntry eq 204 or AbsoluteEntry eq 206
ChartOfAccounts: Code eq '4.01.02.01.01'
```

Contagem e releitura sao controles da mesma Service Layer, nao uma fonte
contabil independente nem snapshot transacional. Um lancamento ja existente
fora da conta escolhida poderia mudar durante as consultas sem alterar a
contagem. A conferencia **matematica** e independente; a origem dos dados e SAP
em ambos os caminhos. Nao foi realizada conferencia manual na interface SAP.

## Artefatos e reproducao

Diretorio da execucao real, ignorado pelo Git:
`.local/ggf/real-rateio-2026-09-28T15-46-30-224Z/`.

Para cada prefixo `direct-cost` e `quantity`:

- `*-source.json`: respostas SAP, consultas, datas e releituras, sem credenciais.
- `*-engine.json`: configuracao, snapshot e memoria integral do motor.
- `*-engine.csv`: memoria exportada pelo FactoryOne.
- `*-independent.json`: bases recompostas, referencias por linha e comparacao.
- `*-comparison.csv`: comparacao numerica por OP, inclusive bruto e ajustes.
- `*-independent-final.json` e `*-technical-validation.csv`: reconferencia
  final, com os mesmos numeros. O CSV inclui empresa, conta, descricao,
  periodo, percentual e a ressalva **NAO GGF FUNCIONAL** em cada linha.

`request.json` registra a selecao; `summary.json` resume os dois cenarios.
BigInts do JSON do motor sao strings escaladas; valores monetarios sao
centavos, quantidade tem seis casas conforme `basisDecimals`. Nos arquivos
independentes, sufixo `Minor` significa centavos, `Micros` micro-unidades.

Hashes SHA-256 das capturas reais originais:

```text
direct-cost-source.json
acc3cc72c71e576103f11986ae6fa01b523d5856ecd56a52efe13d00175176a0
quantity-source.json
b93c1f8dbe43e9fb6b3d83c6a397ede69e12b02ace32cd215ddb2ac4c96a0d4d
```

Nova leitura real (pode produzir outros valores se o SAP mudar):

```sh
npm run ggf:sap:validate -- .local/ggf/real-validation-request.json
```

Reproduzir motor + conferencia sobre as capturas originais, **sem rede nem login**:

```sh
npm run ggf:sap:validate -- --replay .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-source.json
npm run ggf:sap:validate -- --replay .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/quantity-source.json
```

Ambos os replays foram executados e passaram. Cada chamada cria outro
diretorio, sem sobrescrever as capturas originais. O modo replay identifica
`sourceMode=replay`, conserva as datas originais, registra data/hash da
reproducao e exige a mesma sequencia de consultas. Versoes atuais do script
registram tambem `code-hashes.json` do motor/adaptador/conferidor utilizados.
O bundle de calculo foi identico na execucao real e nos dois replays:
SHA-256 `05ce2560d44fd632a5b9c7e33f0f8f9c75c20e9c5006cc42fdeb77a0eca68ccc`.
O conferidor atualizado tambem foi reexecutado isoladamente nos dois pares
originais, sem divergencias e sem sobrescrever as evidencias da primeira execucao.

Conferencia independente isolada, sem reconstruir o bundle:

```sh
python3 scripts/ggf-independent-check.py \
  .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-source.json \
  .local/ggf/real-rateio-2026-09-28T15-46-30-224Z/direct-cost-engine.json \
  .local/ggf/direct-cost-recheck.json .local/ggf/direct-cost-recheck.csv
```

Requer Node24, dependencias do projeto e Python3 com biblioteca padrao.
Credenciais continuam somente na configuracao local ignorada `.env`.

## Limitacoes e decisoes funcionais

1. A conta financeira usada **nao e GGF funcional**. Definir contas/naturezas
   elegiveis continua sendo decisao do cliente. Nenhum pool oficial foi criado.
2. Percentual75%, tres OPs e materiais+recursos sao parametros desta prova
   tecnica. Nao constituem regra de fechamento para toda a producao.
3. Tarifas dos recursos podem conter indiretos; esta prova nao esclarece sua
   composicao economica nem elimina o risco de dupla absorcao do diagnostico.
4. Nao existem horas reais validadas para setembro; nao foi executado HOURS.
   Grupo de recurso nao foi necessario para esta primeira prova.
5. Quantidade compara somente o mesmo item/unidade. Equivalencia entre produtos
   ou outra normalizacao exige justificativa funcional, nao uma soma de UN.
6. Setembro esta aberto. Novos lancamentos, estornos ou alteracoes exigem nova
   captura. Os controles nao garantem atomicidade transacional.
7. Custo atual de estoque e destino contabil continuam fora do escopo. Nao se
   calculou reavaliacao, custo atualizado nem saldo remanescente por OP.
8. Teste restrito ao escopo comprovado do adaptador: setembro2026, essas OPs,
   sem filtros de filial/dimensao. Nao certifica outros periodos ou empresas.

**Conclusao:** extracao real, calculo e conciliacao independente passaram,
inclusive arredondamento por OP e diferenca zero. Isso nao aprova contabilizar
esses valores nem tratar a conta financeira como custo industrial.

## Arquivos e verificacoes

Criados: este documento, `scripts/ggf-real-validation.mjs`,
`scripts/ggf-independent-check.py`, `test/ggf/independentRateio.test.ts` e
`test/ggf/test_independent_rateio.py`. `package.json` ganhou `ggf:sap:validate`.
Configuracao e artefatos reais ficaram exclusivamente em `.local/ggf/`.
Links atualizados em `README.md`, `docs/GGF-READ-MAPPING.md` e
`docs/GGF-RATEIO-ENGINE.md`, sem alteracoes no motor, adaptador ou tela.

Verificacoes executadas em 28/09/2026:

- `npm test`: **337 testes aprovados em26 arquivos**, incluindo o executor dos
  **16 testes Python** independentes, todos aprovados com dados inventados.
- `npm run typecheck`: aprovado.
- `npm run test:browser -- --timeout 180000`: **21/21 aprovados** em execucao
  completa (7 minutos), sem repeticao de falhas. Limite ampliado apenas por
  comando; as assercoes e o codigo dos testes de navegador nao foram alterados.
  Esses testes bloqueiam acesso externo/SAP; nao sao a prova da leitura real.
- Leitura real: dois cenarios aprovados; zero diferencas por OP ou no total.
- Replay offline e reconferencia Python isolada: ambos os cenarios aprovados.
- `node --check scripts/ggf-real-validation.mjs`: aprovado.
- Capturas originais preservadas por SHA-256; `.env` e artefatos locais
  confirmados como ignorados pelo Git.
- `git diff --check -- . ':!.gitignore'`: aprovado; a alteracao preexistente de
  `.gitignore` nao foi editada nesta etapa.

`npm run build` com MBT Linux1.2.47: aprovado, incluindo `build:module`, geracao
de `WebClientExtension.json`, compressao e
`mta_archives/ext-factoreone_0.1.0.mtar`. Tanto o MTA quanto
`resources/factoreoneapp.zip` passaram em `python3 -m zipfile -t`.
Ressalva ambiental: o Make avisou sobre clock skew no filesystem Windows/WSL;
o build terminou com codigo0 e os arquivos compactados passaram na integridade.
O pacote **nao foi instalado nem validado dentro do Web Client**.
