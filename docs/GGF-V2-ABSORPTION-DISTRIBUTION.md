# GGF V2 — distribuição da diferença de absorção

## Escopo

Esta é a Fase 2 técnica da V2. A conciliação por categoria da Fase 1 alimenta,
separadamente, o motor de rateio existente:

```text
saldo líquido técnico da categoria = custo real mapeado - custo padrão absorvido mapeado
parcela submetida = saldo líquido técnico × percentual da conta
valor por OP = parcela submetida × base comprovada da OP / base total elegível
```

A primeira implementação usa explicitamente 100% da diferença técnica de cada
categoria quando ela tem conta configurada. MOD e GGF são chamadas independentes
de `allocate()`. Não houve mudança na matemática do motor V1. Valores negativos
mantêm o sinal; o ajuste de centavos continua pelo maior resto determinístico
do motor. Uma categoria bloqueada não impede publicar a outra, mas seu saldo
continua no total não distribuído.

Esta saída **não** é uma apuração funcional aprovada. O valor representa a
diferença dos mapeamentos selecionados, não uma regra contabilística homologada.
Não há contabilização, criação de reavaliação, atualização de custo/estoque,
alteração de OP ou recurso. Os estados do fechamento e os bloqueios V1 não
foram alterados.

## Implementação

- `absorption/distribution.ts` orquestra MOD e GGF em separado, consulta a
  `SapGgfCalculationSource`, adapta cada diferença para um saldo técnico
  sintético e chama o mesmo `allocate()` usado pela V1. Cada configuração usa
  100% do pool técnico; a configuração do usuário não é gravada no SAP.
- `AbsorptionMapping.distribution` armazena localmente critério, OPs elegíveis
  e percentuais/bases de grupo independentes por categoria. A tela usa `localStorage` e o
  JSON de mapeamento explícito. Contas ausentes bloqueiam aquela categoria.
- O preview local expõe somente `GET /__ggf/v2/distribution`, exige o opt-in
  same-origin e a empresa SBODEMOBR2. A chamada só faz leituras Service Layer;
  autenticação/logout são controle da sessão. O gateway não oferece POST,
  PATCH ou ação SAP para este fluxo.
- A interface mostra a conciliação real/padrão/diferença, estado de cada
  categoria, diferenças distribuídas e pendentes e resultado por OP/produto.
  A memória inclui critério, base/total, participação, valor, arredondamento e
  referências de origem. Custos originais são rotulados como base técnica,
  sem alegação de custo contábil unitário do produto.
- JSON e CSV reproduzíveis de homologação são gravados apenas em `.local/ggf/`
  com permissão local restrita. Não são artefatos versionados.

## Critérios e bloqueios

Os quatro critérios preservam os contratos do motor:

| Critério | Fonte/uso | Bloqueio explícito |
| --- | --- | --- |
| Absorção por Custo Direto | Materiais e recursos documentados pela fonte validada; memória de componentes | Lifecycle, composição, unidade/normalização ou evidência de qualquer OP insuficiente |
| Quantidade Produzida | Recebimento efetivo e quantidade elegível no período | Produto/unidade/comparison key incompatíveis; não soma produtos diferentes |
| Horas Apontadas | Apenas apontamento real homologado | Setembro/2026 não possui fonte de horas reais; horas planejadas nunca substituem |
| Grupo de Recurso | Percentual por grupo; distribuição interna por `RESOURCE_VALUE`, `RESOURCE_QUANTITY` ou `HOURS` explícitos | Soma de grupo inválida, grupo sem OP ou base/unidade/comparabilidade ausente |

Filial e dimensões não são combinadas à base de produção por esta fonte e
bloqueiam a categoria. Nenhum fallback troca critério automaticamente. Conta
sem configuração também fica bloqueada. Um zero de base e origem incompleta
continuam bloqueios do motor/source evidence, não são convertidos em rateio
presumido.

`RESOURCE_GROUP` usa percentuais configurados cuja soma precisa ser 100% e a
base efetiva selecionada de cada grupo. Não se cria hora a partir de cadastro,
tarifa ou quantidade planejada. A interface aceita JSON explícito de grupos;
exemplo apenas estrutural (não é configuração de produção):

```json
[{"group":"<código SAP>","percent":"20","basis":"RESOURCE_VALUE"}]
```

O critério e as OPs de MOD e GGF são selecionados separadamente. A lista de OP
é checada contra a leitura de origem; DocEntry não é inferido pelo usuário.

## Cenário reproduzível SBODEMOBR2

O request técnico local usa setembro/2026, sem filial/dimensão, OPs 76, 77 e
79 e a conta `4.01.01.04.07` atribuída tecnicamente a GGF. Ela foi anteriormente
identificada como `Despesas Assessoria e Consultoria`, com risco de dupla
absorção; **não é conta GGF funcional**. A configuração Cost1/Cost2 de
`R300007` continua diagnóstica, e as tarifas Resource são atuais, sem evidência
de vigência histórica em setembro. MOD fica sem conta contábil mapeada e por
isso deve permanecer bloqueado. O período ainda não está fechado.

O critério inicial tecnicamente disponível é `DIRECT_COST`, já validado para
estas OPs no diagnóstico V1. `QUANTITY` não pode combinar os produtos distintos
das três OPs. Horas reais não estão disponíveis. `RESOURCE_GROUP` ainda não
tem associação suficiente de grupo/base para ser escolhida como regra.

Comandos, a partir da raiz do repositório:

```sh
node scripts/ggf-v2-absorption-distribution-live.mjs
```

O script exige `.env` local já configurado para SBODEMOBR2 e usa o request
ignorado `.local/ggf/v2-absorption-distribution-request.json`. O script não
registra a credencial. Saídas padrão:

- `.local/ggf/v2-absorption-distribution-result.json`
- `.local/ggf/v2-absorption-distribution-result.csv`

O script recalcula conta menos absorção diretamente das linhas lidas e refaz a
proporção por custo direto com aritmética inteira própria. Compara diferença
total e cada OP com o motor. A igualdade prova reprodução matemática dos dados
selecionados; não prova classificação de conta, qualidade da tarifa histórica,
completude funcional do pool nem validade contábil.

### Resultado da execução real

Leitura concluída em `2026-09-30T18:00:03.827Z` contra Service Layer
`1000340`, base `/b1s/v2`, TLS verificado, empresa `SBODEMOBR2`. O request
usou setembro/2026, sem filial/dimensões, e OPs 76, 77 e 79. Contagens desta
captura: `JournalEntries` 90/90, `ChartOfAccounts` 1/1, `ProductionOrders` 3/3,
`InventoryGenEntries` 10/10, `InventoryGenExits` 11/11, `Resources` 8/8,
`ResourceGroups` 1/1. O mês ainda estava aberto.

| Categoria | Real mapeado | Padrão mapeado | Diferença técnica | Critério | Status | Distribuído | Não distribuído |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| MOD | R$ 0,00 | R$ 3.000,00 | -R$ 3.000,00 | Custo direto solicitado | `BLOCKED_NO_ACCOUNT` | R$ 0,00 | -R$ 3.000,00 |
| GGF | -R$ 4.666,00 | R$ 1.500,00 | -R$ 6.166,00 | Custo direto | `CALCULATED_TECHNICAL` | -R$ 6.166,00 | R$ 0,00 |

MOD não tinha conta real mapeada e corretamente não recebeu rateio. GGF usou
somente para demonstração a conta `4.01.01.04.07` (`Despesas Assessoria e
Consultoria`), sem afirmar que é GGF funcional. O saldo agregado desta execução
é -R$ 9.166,00; o motor distribuiu -R$ 6.166,00 e preservou -R$ 3.000,00 como
saldo bloqueado de MOD. O resíduo matemático da categoria calculada GGF é zero;
o resíduo global é -R$ 3.000,00, não zero.

Memória GGF por OP, em centavos (base validada `DOCUMENTED_MATERIALS_AND_RESOURCES`):

| OP | Item | Custo direto base | Participação | Valor bruto/final rateado | Ajuste de arredondamento |
| --- | --- | ---: | ---: | ---: | ---: |
| 76 | C00003 | 550.058 | 96,193752% | -593.131 | -1 centavo |
| 77 | z202604 | 10.884 | 1,903386% | -11.736 | 0 |
| 79 | z202604 | 10.881 | 1,902862% | -11.733 | 0 |
| **Total** |  | **571.823** | **100%** | **-616.600** | **-1 centavo atribuído** |

O total fecha em centavos. Conferência aritmética independente refez
`-616.600 × base_OP / 571.823` e maior resto com IDs de OP estáveis; os três
valores por OP coincidiram com `allocate()` exatamente. Diferença total e linhas
comparadas: **passou**. A evidência foi gravada em
`.local/ggf/v2-absorption-distribution-result.json` e `.csv`, ignorados pelo Git.

Isso é prova matemática/técnica, não validação funcional do pool: tarifa atual
sem histórico comprovado, conta de consultoria técnica, CostN de outros recursos
sem classificação, R300010/R300011 sem unidade, e absorção padrão mapeada
incompleta. O relatório mantém esses bloqueios. A soma distribuída fechar não
resolve classificação, dupla absorção ou custo histórico.

## Limitações ainda abertas

- Setembro/2026 ainda está aberto e pode mudar entre execuções.
- `4.01.01.04.07` é conta técnica, não classificação aprovada.
- O mapeamento MOD local não tem conta real: nenhuma distribuição MOD é
  apresentada como pronta.
- O mapeamento de recursos não cobre todos os recursos e componentes não zero;
  a diferença calculada por categoria depende dos componentes explicitamente
  configurados, não representa necessariamente todo o padrão absorvido.
- `Resource.CostN` é tarifa atual sem histórico comprovado para os movimentos
  de setembro; resultado comparável deve ser tratado como diagnóstico.
- Horas reais inexistentes bloqueiam `HOURS`. Não há regra de grupo/base
  aprovada. Quantidade não agrega produtos distintos.
- Percentual funcional por conta/classificação, tratamento de crédito/saldo
  negativo e fechamento do período dependem da Controladoria.
- A etapa estoque versus consumido/CPV, reavaliação V2, integração persistente
  de configuração e fechamento V2 continuam fora desta fase.

## Testes adicionados

Os testes controlados verificam: MOD/GGF isolados, valor negativo preservado,
conciliação por OP, horas ausentes bloqueando somente a categoria afetada,
quantidade incompatível bloqueando a categoria e categoria sem conta sem
alocação. A suíte preexistente do motor continua cobrindo zero de base,
percentual de grupo inválido, grupo sem OP, arredondamento, sinal e evidência.
