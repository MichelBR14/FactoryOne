# Contrato de dados normalizados do GGF

Este contrato define a fronteira de dados normalizados. As fontes concretas
estao no [mapeamento SAP](GGF-READ-MAPPING.md). A contabilizacao continua bloqueada.

Atualizacao de 28/09/2026: a leitura parcial das fontes reais foi implementada
separadamente, conforme [levantamento SAP](GGF-READ-MAPPING.md). Este contrato
nao transforma ausencias em bases. A evolucao para calculo matematico sem
valorizacao esta no [motor de rateio](GGF-RATEIO-ENGINE.md): bases indisponiveis
sao null, com evidencia null e motivo em `OrderBasis.unavailable`. Somente
criterios que dependem delas bloqueiam; nao se exige custo atual para ratear.

## Bases por ordem

`OrderBasis.basisEvidence` e obrigatorio; suas chaves podem ser null somente
quando a respectiva base e null e tem motivo declarado. Cada base disponivel informa:

| Campo | Obrigacao do adaptador |
| --- | --- |
| `unit` | Unidade **apos** conversao; horas em `h`; custos na moeda de `snapshot.evidence.currency`. |
| `comparisonKey` | Identificador da definicao comparavel entre ordens, incluindo versao e escopo. Unidade igual, por si so, nao comprova comparabilidade. |
| `normalizationRef` | Referencia resolvivel para a regra versionada de normalizacao e sua memoria de conversao. |
| `readId` | Coleta declarada em `snapshot.evidence.reads`. |
| `sourceRefs` | Identificadores estaveis das linhas de origem dessa coleta, nao apenas numeros de documentos. |

A evidencia de normalizacao deve conservar valores/unidades originais, fatores
de conversao, precisao/arredondamento aplicados e os responsaveis pela validacao
da regra. Conversoes diferentes por item podem ter referencias diferentes, mas
devem produzir a mesma unidade e a mesma definicao de comparabilidade.

Para quantidade, produtos diferentes podem precisar de unidades equivalentes ou
outro criterio; nao basta declarar todos como "UN". A regra deve ser validada
funcionalmente antes de gerar uma `comparisonKey` comum. Para horas, a evidencia
cobre o total e `groupHours`, recursos incluidos, conversoes de tempo, mapeamento
de grupos e tratamento de sobreposicoes. Para custo direto, deve identificar
componentes e recursos incluidos, competencia, moeda, conversao cambial quando
aplicavel e estornos. Custo atual e o total da OP no momento de captura, nao
custo unitario ou somente custo do periodo.

O motor exige metadados para todas as bases disponiveis e compara as definicoes das bases
usadas pelos criterios ativos. Por exemplo, unidades de quantidade diferentes
nao impedem um rateio exclusivamente por custo direto. Moedas e horas sempre
devem respeitar as unidades normalizadas do contrato. O motor atual trabalha
com duas casas monetarias e ate seis casas para quantidade/horas.

## Origem e completude

Cada `ReadEvidence` representa uma coleta de saldos (`balances`), movimentos
de producao (`production`) ou custos atuais (`currentCosts`). Varias coletas por
categoria sao permitidas, com IDs distintos. Cada uma declara a fonte logica,
os filtros exatos, numero de paginas, linhas recebidas, esgotamento da paginacao,
contagem esperada e referencia da conciliacao independente dessa contagem.

`expectedRows` nao deve ser copiado de `receivedRows` para fabricar igualdade.
`reconciliationRef` deve resolver uma evidencia de controle independente no
mesmo escopo e instante consistente de extracao. As referencias distintas de
linhas presentes no snapshot tambem devem cobrir todas as linhas recebidas de
cada coleta. Assim, descartar uma ordem depois da leitura invalida a apuracao,
salvo exclusao explicitamente identificada em `excludedSourceRefs`, com regra
em `exclusionRef`, sem sobreposicao com as referencias usadas. O adaptador deve
conferir esses IDs com as linhas efetivamente lidas, nao apenas contar strings.
`supportingReads` registra vinculos de apoio (OP, recurso, grupo).
`requestPath`, `controlPath` e `scope` identificam consultas concretas e diferenciam
cadastros atuais de movimentos filtrados pelo periodo; `filter` identifica a
apuracao a que a evidencia pertence. Nao presume data historica em cadastros.
Saldos carregam moeda e `readId`, alem das referencias das linhas agregadas.

`resourceBases` guarda consumo comprovado por grupo, com valor, evidencia e
referencias de recursos. Horas permanecem em `hours`/`groupHours`, sem conversao
automatica de consumo. `directCostComponents` preserva a composicao e concilia
com `directCost`; e obrigatorio no calculo SAP por custo direto.
Moeda pode ser ISO ou `SAP_LOCAL` no mapeamento restrito de moeda local sem
conversao. Ausencia de `currentCost` deixa custo resultante null, nunca zero.

O adaptador deve garantir consistencia entre coletas, paginacao completa,
elegibilidade das ordens, exclusao de lancamentos proprios e ausencia de dupla
contagem. Se o servidor nao permitir comprovar esses pontos, deve falhar em vez
de declarar completude ou presumir saldo zero. Um saldo zero sem linhas so pode
ser retornado apos uma coleta completa e conciliada no escopo solicitado.

O motor rejeita evidencias ausentes, filtros divergentes, referencias de coleta
invalidas, contagens divergentes, paginas pendentes e bases usadas com unidades
ou definicoes incompativeis. A exportacao CSV preserva referencias de origem,
normalizacao, unidades, definicoes e controles de completude.

Essas validacoes verificam **consistencia das declaracoes**, nao a veracidade da
fonte externa. Resolver e conferir as evidencias contra o SAP permanece tarefa
do adaptador e dos testes de integracao com dados industriais adequados.

## Exemplo de desenvolvimento

O repositorio local declara `DEV-UNIT` como unidade ficticia comum de quantidade,
horas em `h` e custos em BRL. As conversoes sao identidades sobre os fixtures,
com referencias `development/fixtures/v1/...`; as contagens de controle sao
obtidas das colecoes ficticias filtradas. Nada disso representa uma regra de
conversao SAP validada ou evidencia de dados reais.
